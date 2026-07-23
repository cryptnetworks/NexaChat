import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsRegistry, Telemetry } from '../src/telemetry.js';

const traceId = '0af7651916cd43dd8448eb211c80319c';
const parentSpanId = 'b7ad6b7169203331';
const trustedCorrelationId = '971fe9aa-01f4-4d0d-89c5-63515cd35d0d';
const generatedCorrelationId = 'fd934f7c-8ac2-4e20-8511-ad3b6fa639bb';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('telemetry trace context', () => {
  it('continues a valid W3C trace with a fresh span when local sampling allows it', () => {
    const telemetry = new Telemetry({ traceSampleRate: 1 });
    const context = telemetry.createContext(
      `00-${traceId}-${parentSpanId}-01`,
      trustedCorrelationId,
    );

    expect(context).toMatchObject({
      correlationId: trustedCorrelationId,
      traceId,
      sampled: true,
    });
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(context.spanId).not.toBe(parentSpanId);
    expect(telemetry.traceparent(context)).toBe(
      `00-${traceId}-${context.spanId}-01`,
    );
  });

  it.each([
    `00-${'0'.repeat(32)}-${parentSpanId}-01`,
    `00-${traceId}-${'0'.repeat(16)}-01`,
    `01-${traceId}-${parentSpanId}-01`,
    `00-${traceId.toUpperCase()}-${parentSpanId}-01`,
    `00-${traceId}-${parentSpanId}-zz`,
    `00-${traceId}-${parentSpanId}-01-attacker-suffix`,
    `00-${traceId}-${parentSpanId}-01\n00-${'f'.repeat(32)}-${parentSpanId}-01`,
  ])('rejects an invalid or hostile traceparent: %s', (traceparent) => {
    const telemetry = new Telemetry({ traceSampleRate: 0, random: () => 1 });
    const context = telemetry.createContext(
      traceparent,
      generatedCorrelationId,
    );

    expect(context.correlationId).toBe(generatedCorrelationId);
    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.traceId).not.toBe(traceId);
    expect(context.sampled).toBe(false);
  });

  it('uses the bounded local sampling rate only when there is no valid parent', () => {
    const values = [0.49, 0.5];
    const sampled = new Telemetry({
      traceSampleRate: 0.5,
      random: () => values.shift() ?? 0.5,
    });

    expect(sampled.createContext().sampled).toBe(true);
    expect(sampled.createContext().sampled).toBe(false);
    expect(
      new Telemetry({ traceSampleRate: 2, random: () => 0.999 }).createContext()
        .sampled,
    ).toBe(true);
    expect(
      new Telemetry({ traceSampleRate: -1, random: () => 0 }).createContext()
        .sampled,
    ).toBe(false);
    expect(
      new Telemetry({
        traceSampleRate: Number.NaN,
        random: () => 0,
      }).createContext().sampled,
    ).toBe(false);
  });

  it('keeps upstream unsampled traces off and caps sampled parents locally', () => {
    expect(
      new Telemetry({ traceSampleRate: 1 }).createContext(
        `00-${traceId}-${parentSpanId}-00`,
      ).sampled,
    ).toBe(false);
    expect(
      new Telemetry({ traceSampleRate: 0 }).createContext(
        `00-${traceId}-${parentSpanId}-01`,
      ).sampled,
    ).toBe(false);
    expect(
      new Telemetry({ traceSampleRate: 1 }).createContext(
        `00-${traceId}-${parentSpanId}-01`,
      ).sampled,
    ).toBe(true);
  });
});

describe('bounded metric labels', () => {
  it.each([
    'id',
    'accountId',
    'actor_id',
    'community_id',
    'messageId',
    'request_id',
    'sessionId',
    'span_id',
    'token_id',
    'traceId',
    'attachmentContent',
    'body',
    'secret',
    'username',
    'email',
    'ip',
    'address',
    'filename',
    'object_key',
    'provider_url',
    'provider_endpoint',
    'url',
    'uri',
    'host',
    'origin',
    'path',
    'query',
    'credential',
    'password',
    'cookie',
    'authorization',
    'display_name',
  ])('rejects the sensitive label name %s', (label) => {
    const metrics = new MetricsRegistry();

    expect(() => {
      metrics.define('nexa_sensitive_total', {
        type: 'counter',
        help: 'Must not be created.',
        labelNames: [label],
      });
    }).toThrow('sensitive metric label');
  });

  it.each([
    'le',
    'quantile',
    '__name__',
    'bad-name',
    'bad.name',
    'bad label',
    'bad\nlabel',
    'bad"label',
    '9invalid',
  ])('rejects the hostile or reserved label name %s', (label) => {
    const metrics = new MetricsRegistry();

    expect(() => {
      metrics.define('nexa_invalid_label_total', {
        type: 'counter',
        help: 'Must not be created.',
        labelNames: [label],
      });
    }).toThrow('invalid metric label');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_049])(
    'rejects the invalid per-metric series budget %s',
    (budget) => {
      expect(() => new MetricsRegistry(budget)).toThrow(
        'invalid metric series budget',
      );
    },
  );

  it('rejects non-finite and negative metric values', () => {
    const metrics = new MetricsRegistry();
    metrics.define('nexa_counter_total', {
      type: 'counter',
      help: 'Counter values.',
      labelNames: [],
    });
    metrics.define('nexa_gauge', {
      type: 'gauge',
      help: 'Gauge values.',
      labelNames: [],
    });
    metrics.define('nexa_histogram', {
      type: 'histogram',
      help: 'Histogram values.',
      labelNames: [],
      buckets: [1],
    });

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => {
        metrics.increment('nexa_counter_total', {}, value);
      }).toThrow('invalid metric value');
      expect(() => {
        metrics.gauge('nexa_gauge', value);
      }).toThrow('invalid metric value');
      expect(() => {
        metrics.observe('nexa_histogram', value);
      }).toThrow('invalid metric value');
    }
    expect(() => {
      metrics.gauge('nexa_gauge', Number.NEGATIVE_INFINITY);
    }).toThrow('invalid metric value');
  });

  it('normalizes allowlisted values before applying the cardinality budget', () => {
    const metrics = new MetricsRegistry(1);
    metrics.define('nexa_normalized_total', {
      type: 'counter',
      help: 'Normalized outcomes.',
      labelNames: ['outcome'],
      allowed: { outcome: new Set(['success', 'other']) },
    });

    metrics.increment('nexa_normalized_total', { outcome: 'private-one' });
    metrics.increment('nexa_normalized_total', { outcome: 'private-two' });

    expect(metrics.seriesCount('nexa_normalized_total')).toBe(1);
    expect(metrics.render()).toContain(
      'nexa_normalized_total{outcome="other"} 2',
    );
    expect(metrics.render()).toContain('nexa_telemetry_dropped_series_total 0');
    expect(metrics.render()).not.toContain('private-one');
  });

  it('drops new series after the per-metric cardinality budget is exhausted', () => {
    const metrics = new MetricsRegistry(2);
    metrics.define('nexa_bounded_total', {
      type: 'counter',
      help: 'Bounded values.',
      labelNames: ['outcome'],
    });

    metrics.increment('nexa_bounded_total', { outcome: 'first' });
    metrics.increment('nexa_bounded_total', { outcome: 'second' });
    metrics.increment('nexa_bounded_total', { outcome: 'third' });

    expect(metrics.seriesCount('nexa_bounded_total')).toBe(2);
    expect(metrics.render()).toContain('nexa_telemetry_dropped_series_total 1');
    expect(metrics.render()).not.toContain('outcome="third"');
  });

  it('ignores undeclared labels instead of rendering private values', () => {
    const metrics = new MetricsRegistry();
    metrics.define('nexa_safe_total', {
      type: 'counter',
      help: 'Only declared labels are emitted.',
      labelNames: ['outcome'],
      allowed: { outcome: new Set(['success', 'other']) },
    });

    metrics.increment('nexa_safe_total', {
      outcome: 'success',
      accountId: 'private-account',
    });

    expect(metrics.render()).toContain('nexa_safe_total{outcome="success"} 1');
    expect(metrics.render()).not.toContain('private-account');
  });

  it('normalizes HTTP method, route identifiers, query data, and status class', () => {
    const telemetry = new Telemetry();
    telemetry.recordHttp(
      'brew',
      `/v1/communities/123e4567-e89b-12d3-a456-426614174000/spaces/42?token=private-token`,
      799,
      250,
    );
    telemetry.recordHttp('GET', 'not/a/safe-route?body=private-body', 200, 1);

    const rendered = telemetry.metrics.render();
    expect(rendered).toContain('method="other"');
    expect(rendered).toContain('route="/v1/communities/:id/spaces/:id"');
    expect(rendered).toContain('status="other"');
    expect(rendered).toContain('route="unmatched"');
    expect(rendered).not.toContain('private-token');
    expect(rendered).not.toContain('private-body');
    expect(rendered).not.toContain('123e4567-e89b-12d3-a456-426614174000');
  });

  it('normalizes unknown WebSocket events and outcomes without private detail', () => {
    const telemetry = new Telemetry();
    telemetry.websocketMetrics().increment('unexpected-provider-event', {
      reason: 'private provider detail',
    });

    const rendered = telemetry.metrics.render();
    expect(rendered).toContain('event="other"');
    expect(rendered).toContain('outcome="other"');
    expect(rendered).not.toContain('private provider detail');
  });

  it('exports zero-valued WebSocket gauges before the first connection', () => {
    const rendered = new Telemetry().metrics.render();

    expect(rendered).toContain('nexa_websocket_state{state="connections"} 0');
    expect(rendered).toContain('nexa_websocket_state{state="subscriptions"} 0');
    expect(rendered).toContain(
      'nexa_websocket_state{state="indexed_spaces"} 0',
    );
    expect(rendered).toContain('nexa_websocket_state{state="queue"} 0');
  });
});
