import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { permissionCatalog, type Permission } from '@nexa/authorization';
import type { WebsocketMetrics } from './websocket.js';

type MetricType = 'counter' | 'gauge' | 'histogram';
type Labels = Readonly<Record<string, string>>;

interface MetricDefinition {
  type: MetricType;
  help: string;
  labelNames: readonly string[];
  allowed?: Readonly<Record<string, ReadonlySet<string>>>;
  buckets?: readonly number[];
}

interface MetricSeries {
  labels: Record<string, string>;
  value: number;
  count: number;
  sum: number;
  buckets: number[];
}

export interface TraceContext {
  correlationId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
}

export interface TelemetryOptions {
  maxSeriesPerMetric?: number;
  traceSampleRate?: number;
  now?: () => number;
  random?: () => number;
}

export type TraceOperation =
  'http.request' | 'message.command' | 'postgres.query' | 'realtime.publish';

type TelemetryLogSink = (record: Record<string, unknown>) => void;

const forbiddenLabel =
  /id$|(?:^|_)id(?:$|_)|content|body|secret|(?:^|_)(?:username|email|ip|address|filename|object_?key|provider_?(?:url|endpoint)|url|uri|host|origin|path|query|credential|password|cookie|authorization|display_?name)(?:$|_)/i;
const prometheusLabelName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const defaultMaxSeriesPerMetric = 512;
const maximumMaxSeriesPerMetric = 2_048;
const uuid =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

export class MetricsRegistry {
  private readonly definitions = new Map<string, MetricDefinition>();
  private readonly series = new Map<string, Map<string, MetricSeries>>();
  private droppedSeries = 0;
  private readonly maxSeriesPerMetric: number;

  constructor(maxSeriesPerMetric = defaultMaxSeriesPerMetric) {
    if (
      !Number.isInteger(maxSeriesPerMetric) ||
      maxSeriesPerMetric < 1 ||
      maxSeriesPerMetric > maximumMaxSeriesPerMetric
    )
      throw new Error('invalid metric series budget');
    this.maxSeriesPerMetric = maxSeriesPerMetric;
  }

  define(name: string, definition: MetricDefinition): void {
    if (!/^nexa_[a-z0-9_]+$/.test(name)) throw new Error('invalid metric name');
    if (
      definition.labelNames.some(
        (label) =>
          !prometheusLabelName.test(label) ||
          label.startsWith('__') ||
          label === 'le' ||
          label === 'quantile',
      )
    )
      throw new Error('invalid metric label');
    if (definition.labelNames.some((label) => forbiddenLabel.test(label)))
      throw new Error('sensitive metric label');
    this.definitions.set(name, definition);
    this.series.set(name, new Map());
  }

  increment(name: string, labels: Labels = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error('invalid metric value');
    const series = this.getSeries(name, labels, 'counter');
    if (series) series.value += amount;
  }

  gauge(name: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value) || value < 0)
      throw new Error('invalid metric value');
    const series = this.getSeries(name, labels, 'gauge');
    if (series) series.value = value;
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value) || value < 0)
      throw new Error('invalid metric value');
    const series = this.getSeries(name, labels, 'histogram');
    if (!series) return;
    const definition = this.requiredDefinition(name);
    series.count += 1;
    series.sum += value;
    for (const [index, bucket] of (definition.buckets ?? []).entries())
      if (value <= bucket)
        series.buckets[index] = (series.buckets[index] ?? 0) + 1;
  }

  render(): string {
    const lines: string[] = [
      '# HELP nexa_telemetry_dropped_series_total Metric series rejected by the cardinality budget.',
      '# TYPE nexa_telemetry_dropped_series_total counter',
      `nexa_telemetry_dropped_series_total ${String(this.droppedSeries)}`,
    ];
    for (const [name, definition] of this.definitions) {
      lines.push(`# HELP ${name} ${definition.help}`);
      lines.push(`# TYPE ${name} ${definition.type}`);
      for (const value of this.series.get(name)?.values() ?? []) {
        const labels = renderLabels(value.labels);
        if (definition.type !== 'histogram') {
          lines.push(`${name}${labels} ${String(value.value)}`);
          continue;
        }
        for (const [index, bucket] of (definition.buckets ?? []).entries())
          lines.push(
            `${name}_bucket${renderLabels({ ...value.labels, le: String(bucket) })} ${String(value.buckets[index] ?? 0)}`,
          );
        lines.push(
          `${name}_bucket${renderLabels({ ...value.labels, le: '+Inf' })} ${String(value.count)}`,
          `${name}_sum${labels} ${String(value.sum)}`,
          `${name}_count${labels} ${String(value.count)}`,
        );
      }
    }
    return `${lines.join('\n')}\n`;
  }

  seriesCount(name: string): number {
    return this.series.get(name)?.size ?? 0;
  }

  private getSeries(
    name: string,
    labels: Labels,
    expectedType: MetricType,
  ): MetricSeries | undefined {
    const definition = this.requiredDefinition(name);
    if (definition.type !== expectedType)
      throw new Error('metric type mismatch');
    const normalized = Object.fromEntries(
      definition.labelNames.map((label) => [
        label,
        normalizeLabel(
          label,
          labels[label] ?? 'unknown',
          definition.allowed?.[label],
        ),
      ]),
    );
    const key = JSON.stringify(normalized);
    const metricSeries = this.series.get(name);
    if (!metricSeries) throw new Error('metric is not defined');
    const existing = metricSeries.get(key);
    if (existing) return existing;
    if (metricSeries.size >= this.maxSeriesPerMetric) {
      this.droppedSeries += 1;
      return undefined;
    }
    const created: MetricSeries = {
      labels: normalized,
      value: 0,
      count: 0,
      sum: 0,
      buckets: (definition.buckets ?? []).map(() => 0),
    };
    metricSeries.set(key, created);
    return created;
  }

  private requiredDefinition(name: string): MetricDefinition {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error('metric is not defined');
    return definition;
  }
}

export class Telemetry {
  readonly metrics: MetricsRegistry;
  private readonly contexts = new AsyncLocalStorage<TraceContext>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sampleRate: number;
  private readonly eventLoop: IntervalHistogram;
  private processTimer: ReturnType<typeof setInterval> | undefined;
  private logSink: TelemetryLogSink | undefined;
  private lastCpuSeconds = 0;

  constructor(options: TelemetryOptions = {}) {
    this.metrics = new MetricsRegistry(
      options.maxSeriesPerMetric ?? defaultMaxSeriesPerMetric,
    );
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sampleRate = boundedRate(options.traceSampleRate ?? 0.01);
    this.eventLoop = monitorEventLoopDelay({ resolution: 20 });
    this.defineMetrics();
    this.metrics.gauge(
      'nexa_process_start_time_seconds',
      (this.now() - process.uptime() * 1_000) / 1_000,
    );
    for (const state of ['active', 'queued', 'failed'])
      this.metrics.gauge('nexa_background_jobs', 0, { state });
    for (const state of ['connections', 'subscriptions', 'queue'])
      this.metrics.gauge('nexa_websocket_state', 0, { state });
  }

  createContext(
    traceparent?: string,
    correlationId: string = randomUUID(),
  ): TraceContext {
    const parent = parseTraceparent(traceparent);
    const locallySampled = this.random() < this.sampleRate;
    return {
      correlationId,
      traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
      spanId: randomBytes(8).toString('hex'),
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      sampled: parent ? parent.sampled && locallySampled : locallySampled,
    };
  }

  setLogSink(sink: TelemetryLogSink): void {
    this.logSink = sink;
  }

  event(record: Record<string, unknown>): void {
    this.safe(() => {
      this.logSink?.(record);
    });
  }

  recordFailure(): void {
    try {
      this.metrics.increment('nexa_telemetry_failures_total');
    } catch {
      // Failure reporting must remain non-authoritative too.
    }
  }

  enter(context: TraceContext): void {
    this.contexts.enterWith(context);
  }

  currentContext(): TraceContext | undefined {
    return this.contexts.getStore();
  }

  traceparent(context: TraceContext): string {
    return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
  }

  async withSpan<T>(
    operation: TraceOperation,
    work: () => Promise<T> | T,
  ): Promise<T> {
    const parent = this.currentContext();
    if (!parent) return work();
    const context = {
      ...parent,
      spanId: randomBytes(8).toString('hex'),
      parentSpanId: parent.spanId,
    };
    const startedAt = this.now();
    try {
      const result = await this.contexts.run(context, work);
      this.recordSpan(operation, 'success', this.now() - startedAt, context);
      return result;
    } catch (error) {
      this.recordSpan(operation, 'failure', this.now() - startedAt, context);
      throw error;
    }
  }

  recordCurrentSpan(
    operation: TraceOperation,
    outcome: 'success' | 'failure',
    durationMs: number,
  ): void {
    const parent = this.currentContext();
    if (!parent) return;
    const context = {
      ...parent,
      spanId: randomBytes(8).toString('hex'),
      parentSpanId: parent.spanId,
    };
    this.recordSpan(operation, outcome, durationMs, context);
  }

  completeRequestSpan(
    outcome: 'success' | 'failure',
    durationMs: number,
    context: TraceContext | undefined = this.currentContext(),
  ): void {
    if (context) this.recordSpan('http.request', outcome, durationMs, context);
  }

  recordHttp(
    method: string,
    route: string,
    statusCode: number,
    durationMs: number,
  ): void {
    this.safe(() => {
      const labels = {
        method: method.toUpperCase(),
        route: normalizeRoute(route),
        status: `${String(Math.floor(statusCode / 100))}xx`,
      };
      this.metrics.increment('nexa_http_requests_total', labels);
      this.metrics.observe(
        'nexa_http_request_duration_seconds',
        durationMs / 1_000,
        labels,
      );
    });
  }

  authenticationFailure(reason: string): void {
    this.safe(() => {
      this.metrics.increment('nexa_authentication_failures_total', { reason });
    });
  }

  rateLimit(
    scope: 'account' | 'address',
    endpoint: 'authentication' | 'invitation' | 'read' | 'write' | 'other',
    outcome: 'allowed' | 'degraded' | 'dependency_failure' | 'limited',
    backend: 'local' | 'shared',
  ): void {
    this.safe(() => {
      this.metrics.increment('nexa_rate_limit_decisions_total', {
        scope,
        endpoint,
        outcome,
        backend,
      });
    });
  }

  authorizationDecision(
    decision: 'allow' | 'deny' | 'error',
    permission: Permission | 'other' = 'other',
  ): void {
    this.safe(() => {
      this.metrics.increment('nexa_authorization_decisions_total', {
        permission,
        decision,
      });
    });
  }

  postgres(
    operation:
      'connect' | 'migration' | 'query' | 'timeout' | 'pool' | 'readiness',
    outcome: 'success' | 'failure' | 'degraded',
    durationMs?: number,
  ): void {
    this.dependency('postgres', operation, outcome, durationMs);
    if (
      (operation === 'query' || operation === 'timeout') &&
      durationMs !== undefined
    )
      this.recordCurrentSpan(
        'postgres.query',
        outcome === 'success' ? 'success' : 'failure',
        durationMs,
      );
  }

  postgresPool(total: number, idle: number, waiting: number): void {
    this.safe(() => {
      this.metrics.gauge('nexa_postgres_pool_connections', total, {
        state: 'total',
      });
      this.metrics.gauge('nexa_postgres_pool_connections', idle, {
        state: 'idle',
      });
      this.metrics.gauge('nexa_postgres_pool_connections', waiting, {
        state: 'waiting',
      });
    });
  }

  coordination(
    operation:
      'connect' | 'operation' | 'retry' | 'timeout' | 'degradation' | 'close',
    outcome: 'success' | 'failure' | 'degraded',
    durationMs?: number,
  ): void {
    this.dependency('coordination', operation, outcome, durationMs);
    if (operation === 'close' && outcome === 'degraded')
      this.event({
        event: 'dependency.close_forced',
        dependency: 'coordination',
        code: 'graceful_close_failed',
      });
  }

  objectStorage(
    operation:
      'connect' | 'put' | 'get' | 'delete' | 'list' | 'timeout' | 'close',
    outcome: 'success' | 'failure' | 'degraded',
    durationMs?: number,
  ): void {
    this.dependency('object_storage', operation, outcome, durationMs);
  }

  websocketMetrics(): WebsocketMetrics {
    const allowed = new Set([
      'realtime_connection_rejected',
      'realtime_connection_opened',
      'realtime_connection_closed',
      'realtime_slow_consumer',
      'realtime_stale_connection',
      'realtime_subscription_changed',
      'realtime_delivery',
    ]);
    const allowedOutcomes = new Set([
      'observed',
      'unauthenticated',
      'origin',
      'capacity',
      'rate_limited',
      'invalid_message',
      'server_draining',
      'added',
      'removed',
      'revalidated',
      'success',
      'no_subscriber',
      'normal',
      'shutdown',
      'policy',
      'internal',
    ]);
    return {
      increment: (name, labels = {}) => {
        this.safe(() => {
          const outcome = labels.reason ?? 'observed';
          this.metrics.increment('nexa_websocket_events_total', {
            event: allowed.has(name) ? name : 'other',
            outcome: allowedOutcomes.has(outcome) ? outcome : 'other',
          });
        });
      },
      gauge: (name, value) => {
        this.safe(() => {
          this.metrics.gauge('nexa_websocket_state', value, {
            state:
              name === 'realtime_connections'
                ? 'connections'
                : name === 'realtime_subscriptions'
                  ? 'subscriptions'
                  : name === 'realtime_outbound_queue_bytes'
                    ? 'queue'
                    : 'other',
          });
        });
      },
      observe: (name, value, labels = {}) => {
        this.safe(() => {
          if (name !== 'realtime_delivery_duration_ms') return;
          const outcome = labels.outcome ?? 'observed';
          this.metrics.observe(
            'nexa_websocket_delivery_duration_seconds',
            value / 1_000,
            {
              outcome: allowedOutcomes.has(outcome) ? outcome : 'other',
            },
          );
        });
      },
    };
  }

  activeRequests(value: number): void {
    this.safe(() => {
      this.metrics.gauge('nexa_http_active_requests', value);
    });
  }

  lifecycle(state: 'starting' | 'ready' | 'draining' | 'stopped'): void {
    this.safe(() => {
      for (const candidate of ['starting', 'ready', 'draining', 'stopped'])
        this.metrics.gauge(
          'nexa_process_lifecycle',
          candidate === state ? 1 : 0,
          {
            state: candidate,
          },
        );
    });
  }

  dependencyHealth(
    dependency: 'postgres' | 'coordination' | 'object_storage',
    status: 'healthy' | 'degraded' | 'disabled',
  ): void {
    this.safe(() => {
      for (const candidate of ['healthy', 'degraded', 'disabled'])
        this.metrics.gauge(
          'nexa_dependency_health',
          candidate === status ? 1 : 0,
          { dependency, status: candidate },
        );
    });
  }

  startProcessCollection(intervalMs = 5_000): void {
    if (this.processTimer) return;
    this.eventLoop.enable();
    this.collectProcess();
    this.processTimer = setInterval(() => {
      this.collectProcess();
    }, intervalMs);
    this.processTimer.unref();
  }

  stopProcessCollection(): void {
    if (this.processTimer) clearInterval(this.processTimer);
    this.processTimer = undefined;
    this.eventLoop.disable();
  }

  private collectProcess(): void {
    this.safe(() => {
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      this.metrics.gauge('nexa_process_memory_bytes', memory.rss, {
        kind: 'resident',
      });
      this.metrics.gauge('nexa_process_memory_bytes', memory.heapUsed, {
        kind: 'heap',
      });
      const cpuSeconds = (cpu.user + cpu.system) / 1_000_000;
      this.metrics.increment(
        'nexa_process_cpu_seconds_total',
        {},
        Math.max(0, cpuSeconds - this.lastCpuSeconds),
      );
      this.lastCpuSeconds = cpuSeconds;
      this.metrics.gauge('nexa_process_uptime_seconds', process.uptime());
      this.metrics.gauge(
        'nexa_process_event_loop_lag_seconds',
        Number.isFinite(this.eventLoop.mean) ? this.eventLoop.mean / 1e9 : 0,
      );
      this.eventLoop.reset();
    });
  }

  private dependency(
    dependency: string,
    operation: string,
    outcome: string,
    durationMs?: number,
  ): void {
    this.safe(() => {
      const labels = { dependency, operation, outcome };
      this.metrics.increment('nexa_dependency_operations_total', labels);
      if (durationMs !== undefined)
        this.metrics.observe(
          'nexa_dependency_operation_duration_seconds',
          durationMs / 1_000,
          labels,
        );
    });
  }

  private recordSpan(
    operation: TraceOperation,
    outcome: 'success' | 'failure',
    durationMs: number,
    context: TraceContext,
  ): void {
    this.safe(() => {
      this.metrics.increment('nexa_trace_spans_total', { operation, outcome });
      this.metrics.observe(
        'nexa_trace_span_duration_seconds',
        durationMs / 1_000,
        {
          operation,
          outcome,
        },
      );
      if (!context.sampled || !this.logSink) return;
      this.logSink({
        event: 'trace.span.completed',
        operation,
        outcome,
        correlationId: context.correlationId,
        traceId: context.traceId,
        spanId: context.spanId,
        ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
        durationMs,
      });
    });
  }

  private safe(operation: () => void): void {
    try {
      operation();
    } catch {
      this.recordFailure();
    }
  }

  private defineMetrics(): void {
    const status = new Set(['1xx', '2xx', '3xx', '4xx', '5xx', 'other']);
    const methods = new Set([
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
      'HEAD',
      'other',
    ]);
    const dependencyOperations = new Set([
      'connect',
      'migration',
      'query',
      'timeout',
      'pool',
      'readiness',
      'operation',
      'retry',
      'degradation',
      'close',
      'put',
      'get',
      'delete',
      'list',
      'other',
    ]);
    this.metrics.define('nexa_http_requests_total', {
      type: 'counter',
      help: 'Completed HTTP requests.',
      labelNames: ['method', 'route', 'status'],
      allowed: { method: methods, status },
    });
    this.metrics.define('nexa_http_request_duration_seconds', {
      type: 'histogram',
      help: 'HTTP request duration.',
      labelNames: ['method', 'route', 'status'],
      allowed: { method: methods, status },
      buckets: [0.005, 0.025, 0.1, 0.5, 1, 5, 15],
    });
    this.metrics.define('nexa_http_active_requests', {
      type: 'gauge',
      help: 'HTTP requests currently in flight.',
      labelNames: [],
    });
    this.metrics.define('nexa_authentication_failures_total', {
      type: 'counter',
      help: 'Authentication failures grouped by public-safe reason.',
      labelNames: ['reason'],
      allowed: {
        reason: new Set([
          'unauthenticated',
          'authentication_failed',
          'rate_limited',
          'identifier_unavailable',
          'csrf_rejected',
          'other',
        ]),
      },
    });
    this.metrics.define('nexa_rate_limit_decisions_total', {
      type: 'counter',
      help: 'Request admission outcomes with bounded privacy-safe dimensions.',
      labelNames: ['scope', 'endpoint', 'outcome', 'backend'],
      allowed: {
        scope: new Set(['account', 'address']),
        endpoint: new Set([
          'authentication',
          'invitation',
          'read',
          'write',
          'other',
        ]),
        outcome: new Set([
          'allowed',
          'degraded',
          'dependency_failure',
          'limited',
        ]),
        backend: new Set(['local', 'shared']),
      },
    });
    this.metrics.define('nexa_authorization_decisions_total', {
      type: 'counter',
      help: 'Authorization decisions without resource identifiers.',
      labelNames: ['permission', 'decision'],
      allowed: {
        permission: new Set([...permissionCatalog, 'other']),
        decision: new Set(['allow', 'deny', 'error', 'other']),
      },
    });
    this.metrics.define('nexa_dependency_operations_total', {
      type: 'counter',
      help: 'Dependency operations and outcomes.',
      labelNames: ['dependency', 'operation', 'outcome'],
      allowed: {
        dependency: new Set([
          'postgres',
          'coordination',
          'object_storage',
          'other',
        ]),
        operation: dependencyOperations,
        outcome: new Set(['success', 'failure', 'degraded', 'other']),
      },
    });
    this.metrics.define('nexa_dependency_operation_duration_seconds', {
      type: 'histogram',
      help: 'Dependency operation duration.',
      labelNames: ['dependency', 'operation', 'outcome'],
      allowed: {
        dependency: new Set([
          'postgres',
          'coordination',
          'object_storage',
          'other',
        ]),
        operation: dependencyOperations,
        outcome: new Set(['success', 'failure', 'degraded', 'other']),
      },
      buckets: [0.001, 0.01, 0.05, 0.25, 1, 5, 15, 60],
    });
    this.metrics.define('nexa_postgres_pool_connections', {
      type: 'gauge',
      help: 'PostgreSQL pool size, idle capacity, and wait queue.',
      labelNames: ['state'],
      allowed: { state: new Set(['total', 'idle', 'waiting', 'other']) },
    });
    this.metrics.define('nexa_dependency_health', {
      type: 'gauge',
      help: 'Current health state of configured dependencies.',
      labelNames: ['dependency', 'status'],
      allowed: {
        dependency: new Set([
          'postgres',
          'coordination',
          'object_storage',
          'other',
        ]),
        status: new Set(['healthy', 'degraded', 'disabled', 'other']),
      },
    });
    this.metrics.define('nexa_websocket_events_total', {
      type: 'counter',
      help: 'WebSocket lifecycle, delivery, and backpressure events.',
      labelNames: ['event', 'outcome'],
      allowed: {
        event: new Set([
          'realtime_connection_rejected',
          'realtime_connection_opened',
          'realtime_connection_closed',
          'realtime_slow_consumer',
          'realtime_stale_connection',
          'realtime_subscription_changed',
          'realtime_delivery',
          'other',
        ]),
        outcome: new Set([
          'observed',
          'unauthenticated',
          'origin',
          'capacity',
          'rate_limited',
          'invalid_message',
          'server_draining',
          'added',
          'removed',
          'revalidated',
          'success',
          'no_subscriber',
          'normal',
          'shutdown',
          'policy',
          'internal',
          'other',
        ]),
      },
    });
    this.metrics.define('nexa_websocket_state', {
      type: 'gauge',
      help: 'Current WebSocket connection and subscription state.',
      labelNames: ['state'],
      allowed: {
        state: new Set(['connections', 'subscriptions', 'queue', 'other']),
      },
    });
    this.metrics.define('nexa_websocket_delivery_duration_seconds', {
      type: 'histogram',
      help: 'WebSocket realtime publication duration.',
      labelNames: ['outcome'],
      allowed: {
        outcome: new Set(['success', 'no_subscriber', 'other']),
      },
      buckets: [0.0005, 0.001, 0.005, 0.025, 0.1, 0.5, 1],
    });
    this.metrics.define('nexa_background_jobs', {
      type: 'gauge',
      help: 'Current background jobs; zero when no job runner is configured.',
      labelNames: ['state'],
      allowed: { state: new Set(['active', 'queued', 'failed', 'other']) },
    });
    this.metrics.define('nexa_trace_spans_total', {
      type: 'counter',
      help: 'Completed sampled and unsampled trace spans.',
      labelNames: ['operation', 'outcome'],
      allowed: {
        operation: new Set([
          'http.request',
          'message.command',
          'postgres.query',
          'realtime.publish',
          'other',
        ]),
        outcome: new Set(['success', 'failure', 'other']),
      },
    });
    this.metrics.define('nexa_trace_span_duration_seconds', {
      type: 'histogram',
      help: 'Completed trace span duration.',
      labelNames: ['operation', 'outcome'],
      allowed: {
        operation: new Set([
          'http.request',
          'message.command',
          'postgres.query',
          'realtime.publish',
          'other',
        ]),
        outcome: new Set(['success', 'failure', 'other']),
      },
      buckets: [0.001, 0.005, 0.025, 0.1, 0.5, 1, 5, 15],
    });
    this.metrics.define('nexa_process_memory_bytes', {
      type: 'gauge',
      help: 'Process memory usage.',
      labelNames: ['kind'],
      allowed: { kind: new Set(['resident', 'heap', 'other']) },
    });
    this.metrics.define('nexa_process_cpu_seconds_total', {
      type: 'counter',
      help: 'Process CPU time.',
      labelNames: [],
    });
    this.metrics.define('nexa_process_start_time_seconds', {
      type: 'gauge',
      help: 'Process start time as Unix epoch seconds.',
      labelNames: [],
    });
    this.metrics.define('nexa_process_uptime_seconds', {
      type: 'gauge',
      help: 'Process uptime in seconds.',
      labelNames: [],
    });
    this.metrics.define('nexa_process_event_loop_lag_seconds', {
      type: 'gauge',
      help: 'Mean event-loop delay.',
      labelNames: [],
    });
    this.metrics.define('nexa_process_lifecycle', {
      type: 'gauge',
      help: 'Process startup, ready, draining, and stopped indicators.',
      labelNames: ['state'],
      allowed: {
        state: new Set(['starting', 'ready', 'draining', 'stopped', 'other']),
      },
    });
    this.metrics.define('nexa_telemetry_failures_total', {
      type: 'counter',
      help: 'Internal telemetry failures isolated from application behavior.',
      labelNames: [],
    });
  }
}

function parseTraceparent(value: string | undefined) {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(
    value ?? '',
  );
  if (!match || /^0+$/.test(match[1] ?? '') || /^0+$/.test(match[2] ?? ''))
    return undefined;
  return {
    traceId: (match[1] ?? '').toLowerCase(),
    spanId: match[2] ?? '',
    sampled: (Number.parseInt(match[3] ?? '00', 16) & 1) === 1,
  };
}

function boundedRate(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function normalizeLabel(
  name: string,
  value: string,
  allowed?: ReadonlySet<string>,
): string {
  if (forbiddenLabel.test(name)) throw new Error('sensitive metric label');
  const normalized =
    name === 'route' ? normalizeRoute(value) : value.slice(0, 80);
  if (!allowed) return normalized || 'unknown';
  return allowed.has(normalized) ? normalized : 'other';
}

function normalizeRoute(value: string): string {
  const path = value
    .split('?', 1)[0]
    ?.replace(uuid, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
  if (!path || path.length > 120 || !/^\/[A-Za-z0-9_/:.-]*$/.test(path))
    return 'unmatched';
  return path;
}

function renderLabels(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries
    .map(
      ([key, value]) =>
        `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`,
    )
    .join(',')}}`;
}
