import { randomUUID } from 'node:crypto';
import { request as requestHttp } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError } from '@nexa/auth';
import { CommunityService, InMemoryPersistence } from '@nexa/domain';
import type { AuthorizationService } from '@nexa/authorization';
import { buildApp, type StorageReadiness } from '../src/app.js';
import type { AuthRuntime } from '../src/auth-routes.js';
import { closeWithinDeadline, OperationalReadiness } from '../src/health.js';
import { Telemetry, type TelemetryOptions } from '../src/telemetry.js';

const traceId = '0af7651916cd43dd8448eb211c80319c';
const parentSpanId = 'b7ad6b7169203331';
const hostileRequestId = 'attacker-controlled-request-id';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const apps: FastifyInstance[] = [];
const telemetryInstances: Telemetry[] = [];

afterEach(async () => {
  for (const telemetry of telemetryInstances.splice(0))
    telemetry.stopProcessCollection();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

describe('production observability HTTP boundary', () => {
  it('mints request identifiers and accepts only valid W3C trace context', async () => {
    const logs: string[] = [];
    const telemetry = trackedTelemetry({ traceSampleRate: 1, random: () => 0 });
    const app = trackedApp(
      buildApp(
        undefined,
        undefined,
        captureAuth(randomUUID(), logs),
        undefined,
        undefined,
        telemetry,
      ),
    );

    const valid = await app.inject({
      method: 'GET',
      url: '/v1/not-a-route',
      headers: {
        'x-request-id': hostileRequestId,
        traceparent: `00-${traceId}-${parentSpanId}-01`,
      },
    });
    const validRequestId = String(valid.headers['x-request-id']);
    expect(valid.statusCode).toBe(404);
    expect(validRequestId).toMatch(uuid);
    expect(validRequestId).not.toBe(hostileRequestId);
    expect(valid.json()).toMatchObject({ correlationId: validRequestId });
    const continued = String(valid.headers.traceparent).match(
      new RegExp(`^00-${traceId}-([0-9a-f]{16})-01$`),
    );
    expect(continued?.[1]).toBeDefined();
    expect(continued?.[1]).not.toBe(parentSpanId);
    expect(logRecords(logs)).toContainEqual(
      expect.objectContaining({
        event: 'trace.span.completed',
        operation: 'http.request',
        traceId,
        parentSpanId,
        correlationId: validRequestId,
      }),
    );

    for (const invalidTraceparent of [
      `00-${traceId.toUpperCase()}-${parentSpanId}-01`,
      `00-${'0'.repeat(32)}-${parentSpanId}-01`,
      `00-${traceId}-${parentSpanId}-01-attacker-suffix`,
    ]) {
      const invalid = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: {
          'x-request-id': hostileRequestId,
          traceparent: invalidTraceparent,
        },
      });
      const mintedRequestId = String(invalid.headers['x-request-id']);
      const replacement = String(invalid.headers.traceparent).match(
        /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/,
      );
      expect(mintedRequestId).toMatch(uuid);
      expect(mintedRequestId).not.toBe(hostileRequestId);
      expect(replacement?.[1]).toBeDefined();
      expect(replacement?.[1]).not.toBe(traceId);
    }
    expect(logs.join('')).not.toContain(hostileRequestId);
  });

  it('keeps liveness, startup, readiness, degradation, and drain responses generic and cache-safe', async () => {
    const logs: string[] = [];
    const telemetry = trackedTelemetry();
    let storageReady = true;
    let coordinationAvailable = false;
    const readiness = new OperationalReadiness(
      requiredStorage(() => storageReady),
      [
        {
          name: 'coordination',
          enabled: true,
          check: () =>
            coordinationAvailable
              ? Promise.resolve()
              : Promise.reject(new Error('private provider topology')),
        },
        {
          name: 'objectStorage',
          enabled: false,
          check: () => Promise.reject(new Error('must not run')),
        },
      ],
      telemetry,
    );
    const app = trackedApp(
      buildApp(
        undefined,
        readiness,
        captureAuth(randomUUID(), logs),
        undefined,
        undefined,
        telemetry,
      ),
    );

    await expectPublicHealth(app, '/health/live', 200, { status: 'ok' });
    await expectPublicHealth(app, '/health/startup', 503, {
      status: 'starting',
    });
    await expectPublicHealth(app, '/health/ready', 503, {
      status: 'unavailable',
    });

    readiness.markStarted();
    await expectPublicHealth(app, '/health/startup', 200, {
      status: 'started',
    });
    await expectPublicHealth(app, '/health/ready', 200, {
      status: 'degraded',
    });

    coordinationAvailable = true;
    await expectPublicHealth(app, '/health/ready', 200, { status: 'ready' });

    storageReady = false;
    await expectPublicHealth(app, '/health/ready', 503, {
      status: 'unavailable',
    });
    const failedDependencyMetrics = telemetry.metrics.render();
    expect(failedDependencyMetrics).toContain(
      'nexa_dependency_health{dependency="postgres",status="healthy"} 0',
    );
    expect(failedDependencyMetrics).toContain(
      'nexa_dependency_health{dependency="postgres",status="degraded"} 1',
    );

    storageReady = true;
    readiness.beginDrain();
    await expectPublicHealth(app, '/health/live', 200, { status: 'ok' });
    await expectPublicHealth(app, '/health/startup', 200, {
      status: 'started',
    });
    await expectPublicHealth(app, '/health/ready', 503, {
      status: 'unavailable',
    });
    const drained = await app.inject({
      method: 'GET',
      url: `/v1/communities?actorId=${randomUUID()}`,
    });
    expect(drained.statusCode).toBe(503);
    expect(drained.headers['cache-control']).toBe('no-store');
    expect(drained.json()).toMatchObject({
      error: 'dependency_unavailable',
      retryable: true,
    });

    expect(logs.join('')).not.toContain('private provider topology');
    expect(
      logRecords(logs)
        .filter(
          (record) =>
            record.event === 'dependency.state_changed' &&
            record.dependency === 'postgres',
        )
        .map((record) => ({
          previous: record.previous,
          status: record.status,
        })),
    ).toEqual([
      { previous: 'unknown', status: 'ok' },
      { previous: 'ok', status: 'degraded' },
      { previous: 'degraded', status: 'ok' },
    ]);
    const recoveredDependencyMetrics = telemetry.metrics.render();
    expect(recoveredDependencyMetrics).toContain(
      'nexa_dependency_health{dependency="postgres",status="healthy"} 1',
    );
    expect(recoveredDependencyMetrics).toContain(
      'nexa_dependency_health{dependency="postgres",status="degraded"} 0',
    );
    for (const response of [
      await app.inject('/health/live'),
      await app.inject('/health/startup'),
      await app.inject('/health/ready'),
    ]) {
      expect(JSON.stringify(response.json())).not.toMatch(
        /postgres|coordination|object|schema|host|port|private/i,
      );
    }
  });

  it('lets admitted HTTP work finish while drain rejects new work and bounded close waits', async () => {
    const telemetry = trackedTelemetry();
    const readiness = new OperationalReadiness(
      requiredStorage(() => true),
      [],
      telemetry,
    );
    readiness.markStarted();
    const service = new CommunityService(new InMemoryPersistence());
    const actor = await service.createAccount('Drain Fixture');
    const entered = deferred();
    const release = deferred();
    const originalList = service.listCommunities.bind(service);
    const list = vi
      .spyOn(service, 'listCommunities')
      .mockImplementation(async (actorId, input) => {
        entered.resolve();
        await release.promise;
        return originalList(actorId, input);
      });
    const app = trackedApp(
      buildApp(service, readiness, undefined, undefined, undefined, telemetry),
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${String(address.port)}/v1/communities?actorId=${actor.id}`;
    const admitted = fetch(endpoint);
    let closing: Promise<void> | undefined;

    try {
      await entered.promise;
      readiness.beginDrain();
      const rejected = await fetch(endpoint);
      expect(rejected.status).toBe(503);
      await expect(rejected.json()).resolves.toMatchObject({
        error: 'dependency_unavailable',
        retryable: true,
      });
      expect(list).toHaveBeenCalledOnce();

      let closeSettled = false;
      closing = closeWithinDeadline(
        [
          {
            name: 'http',
            close: async () => {
              await app.drainHttp?.();
              await app.close();
            },
          },
        ],
        1_000,
        telemetry,
        vi.fn(),
      ).finally(() => {
        closeSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeSettled).toBe(false);

      release.resolve();
      await expect(admitted).resolves.toMatchObject({ status: 200 });
      await expect(closing).resolves.toBeUndefined();
    } finally {
      release.resolve();
      await Promise.allSettled([admitted, closing ?? Promise.resolve()]);
    }
  });

  it('finalizes an aborted loopback request once without leaking request metadata', async () => {
    const logs: string[] = [];
    const telemetry = trackedTelemetry({ traceSampleRate: 1 });
    const entered = deferred();
    const release = deferred();
    const app = trackedApp(
      buildApp(
        undefined,
        undefined,
        captureAuth(randomUUID(), logs),
        undefined,
        undefined,
        telemetry,
      ),
    );
    app.get('/test/abort', async () => {
      entered.resolve();
      await release.promise;
      return { status: 'late' };
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const privateQuery = 'private-abort-query';
    const client = requestHttp({
      host: '127.0.0.1',
      port: address.port,
      path: `/test/abort?token=${privateQuery}`,
      headers: {
        'x-request-id': hostileRequestId,
        traceparent: `00-${traceId}-${parentSpanId}-01`,
      },
    });
    client.on('error', () => {});
    const clientClosed = new Promise<void>((resolve) => {
      client.once('close', resolve);
    });
    client.end();

    try {
      await entered.promise;
      client.destroy();
      await clientClosed;
      await vi.waitFor(() => {
        const records = logRecords(logs);
        expect(records).toContainEqual(
          expect.objectContaining({
            event: 'http.request.aborted',
            traceId,
            route: '/test/abort',
            statusCode: 499,
          }),
        );
        expect(records).toContainEqual(
          expect.objectContaining({
            event: 'trace.span.completed',
            operation: 'http.request',
            outcome: 'failure',
            traceId,
          }),
        );
        expect(telemetry.metrics.render()).toContain(
          'nexa_http_active_requests 0',
        );
      });

      const serialized = logs.join('');
      expect(serialized).not.toContain(hostileRequestId);
      expect(serialized).not.toContain(privateQuery);
      expect(
        logRecords(logs).filter(
          (record) => record.event === 'http.request.aborted',
        ),
      ).toHaveLength(1);
      expect(telemetry.metrics.render()).toContain(
        'nexa_trace_spans_total{operation="http.request",outcome="failure"} 1',
      );
    } finally {
      release.resolve();
      client.destroy();
      await clientClosed;
    }
  });

  it('exports bounded metric families without request or private-data identifiers', async () => {
    const fixture = await observabilityFixture();
    const {
      app,
      telemetry,
      owner,
      outsiderId,
      communityId,
      spaceId,
      privateValues,
    } = fixture;

    const seeded = await seedObservableRequests(fixture);
    telemetry.startProcessCollection(60_000);
    telemetry.stopProcessCollection();
    telemetry.postgres('connect', 'success', 2);
    telemetry.coordination('timeout', 'degraded', 3);
    telemetry.objectStorage('get', 'failure', 4);
    telemetry.websocketMetrics().increment('realtime_connection_rejected', {
      reason: 'origin',
    });
    telemetry.websocketMetrics().gauge('realtime_connections', 1);
    telemetry.rateLimit('account', 'write', 'limited', 'shared');

    const response = await app.inject('/metrics');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const metrics = response.body;
    for (const metric of [
      'nexa_http_requests_total',
      'nexa_http_request_duration_seconds',
      'nexa_authentication_failures_total',
      'nexa_rate_limit_decisions_total',
      'nexa_authorization_decisions_total',
      'nexa_process_memory_bytes',
      'nexa_process_cpu_seconds_total',
      'nexa_process_event_loop_lag_seconds',
      'nexa_process_lifecycle',
      'nexa_dependency_operations_total',
      'nexa_dependency_health',
      'nexa_websocket_events_total',
      'nexa_websocket_state',
      'nexa_trace_spans_total',
      'nexa_trace_span_duration_seconds',
    ])
      expect(metrics).toContain(metric);
    expect(metrics).toContain(
      'nexa_authentication_failures_total{reason="authentication_failed"} 1',
    );
    expect(metrics).toContain(
      'nexa_rate_limit_decisions_total{scope="account",endpoint="write",outcome="limited",backend="shared"} 1',
    );
    expect(metrics).toContain(
      'nexa_authorization_decisions_total{permission="other",decision="deny"} 1',
    );
    expect(metrics).toContain(
      'nexa_dependency_health{dependency="postgres",status="healthy"} 1',
    );
    expect(metrics).toContain('operation="message.command"');
    expect(metrics).toContain('operation="realtime.publish"');
    expect(metrics).toContain('event="realtime_connection_rejected"');
    expect(metrics).toContain('nexa_telemetry_dropped_series_total 0');

    for (const privateValue of [
      hostileRequestId,
      traceId,
      parentSpanId,
      ...seeded.requestIds,
      seeded.messageId,
      owner.id,
      outsiderId,
      communityId,
      spaceId,
      ...Object.values(privateValues),
    ])
      expect(metrics).not.toContain(privateValue);
    expect(metrics).not.toMatch(
      /route="[^"]*[0-9a-f]{8}-[0-9a-f-]{27,}[^"]*"/i,
    );
  });

  it('emits correlated trace events while excluding bodies, credentials, queries, and provider errors', async () => {
    const fixture = await observabilityFixture();
    const { logs, owner, communityId, spaceId, privateValues } = fixture;

    const { messageResponse } = await seedObservableRequests(fixture);
    const correlationId = String(messageResponse.headers['x-request-id']);
    const records = logRecords(logs);
    const events = records.map((record) => record.event);
    expect(events).toEqual(
      expect.arrayContaining([
        'http.request.started',
        'http.request.completed',
        'http.request.rejected',
        'dependency.state_changed',
        'trace.span.completed',
      ]),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: 'dependency.state_changed',
        dependency: 'postgres',
        previous: 'unknown',
        status: 'ok',
      }),
    );

    const messageSpans = records.filter(
      (record) =>
        record.event === 'trace.span.completed' &&
        ['message.command', 'realtime.publish'].includes(
          String(record.operation),
        ),
    );
    expect(messageSpans.map((record) => record.operation)).toEqual([
      'message.command',
      'realtime.publish',
    ]);
    for (const span of messageSpans)
      expect(span).toMatchObject({
        correlationId,
        traceId,
        outcome: 'success',
      });
    expect(
      records.some(
        (record) =>
          record.event === 'http.request.started' &&
          record.correlationId === correlationId &&
          record.traceId === traceId,
      ),
    ).toBe(true);
    expect(
      records.some(
        (record) =>
          record.event === 'http.request.completed' &&
          record.correlationId === correlationId &&
          record.traceId === traceId,
      ),
    ).toBe(true);

    const serialized = logs.join('');
    for (const privateValue of [
      hostileRequestId,
      owner.id,
      communityId,
      spaceId,
      ...Object.values(privateValues),
    ])
      expect(serialized).not.toContain(privateValue);
  });
});

interface Fixture {
  app: FastifyInstance;
  telemetry: Telemetry;
  logs: string[];
  owner: { id: string };
  outsiderId: string;
  communityId: string;
  spaceId: string;
  auth: AuthRuntime;
  privateValues: {
    messageBody: string;
    username: string;
    password: string;
    token: string;
    authorization: string;
    query: string;
    providerError: string;
    idempotencyKey: string;
  };
}

async function observabilityFixture(): Promise<Fixture> {
  const logs: string[] = [];
  const telemetry = trackedTelemetry({ traceSampleRate: 1 });
  const persistence = new InMemoryPersistence();
  const service = new CommunityService(persistence);
  const owner = await service.createAccount('Private Display Name');
  const community = await service.createCommunity(
    owner.id,
    'Private Community',
  );
  const space = await service.createTextSpace(
    community.id,
    owner.id,
    'Private Space',
  );
  const privateValues = {
    messageBody: 'private-message-body-never-log',
    username: 'private-observability-user',
    password: 'private-password-never-log',
    token: 'T'.repeat(43),
    authorization: 'Bearer private-authorization-never-log',
    query: 'private-query-never-log',
    providerError: 'private-provider-error-never-log',
    idempotencyKey: 'private-idempotency-key',
  };
  const auth = captureAuth(owner.id, logs, privateValues);
  let providerAvailable = false;
  const readiness = new OperationalReadiness(
    requiredStorage(() => true),
    [
      {
        name: 'coordination',
        enabled: true,
        check: () =>
          providerAvailable
            ? Promise.resolve()
            : Promise.reject(new Error(privateValues.providerError)),
      },
    ],
    telemetry,
  );
  readiness.markStarted();
  const authorization = {} as AuthorizationService;
  const app = trackedApp(
    buildApp(service, readiness, auth, authorization, undefined, telemetry),
  );
  app.websocketHub = { broadcast: vi.fn(), close: () => Promise.resolve() };
  providerAvailable = false;
  return {
    app,
    telemetry,
    logs,
    owner,
    outsiderId: randomUUID(),
    communityId: community.id,
    spaceId: space.id,
    auth,
    privateValues,
  };
}

async function seedObservableRequests(fixture: Fixture): Promise<{
  messageResponse: Awaited<ReturnType<FastifyInstance['inject']>>;
  messageId: string;
  requestIds: string[];
}> {
  const { app, auth, owner, outsiderId, communityId, spaceId, privateValues } =
    fixture;
  const provider = await app.inject('/health/ready');
  expect(provider.statusCode).toBe(200);
  expect(provider.json()).toEqual({ status: 'degraded' });

  const login = await app.inject({
    method: 'POST',
    url: `/v1/auth/login?token=${privateValues.query}`,
    headers: {
      origin: auth.config.trustedOrigin,
      cookie: `nexa_session=${privateValues.token}`,
      authorization: privateValues.authorization,
      'x-request-id': hostileRequestId,
    },
    payload: {
      username: privateValues.username,
      password: privateValues.password,
    },
  });
  expect(login.statusCode).toBe(401);

  const denied = await app.inject({
    method: 'POST',
    url: `/v1/permissions/preview?token=${privateValues.query}`,
    headers: { cookie: `nexa_session=${privateValues.token}` },
    payload: {
      actorId: outsiderId,
      permission: 'community.view',
      scopes: [{ type: 'community', id: communityId }],
    },
  });
  expect(denied.statusCode).toBe(404);

  const messageResponse = await app.inject({
    method: 'POST',
    url: `/v1/spaces/${spaceId}/messages?token=${privateValues.query}`,
    headers: {
      origin: auth.config.trustedOrigin,
      'x-nexa-csrf': '1',
      cookie: `nexa_session=${privateValues.token}`,
      authorization: privateValues.authorization,
      'x-request-id': hostileRequestId,
      traceparent: `00-${traceId}-${parentSpanId}-01`,
    },
    payload: {
      authorId: owner.id,
      body: privateValues.messageBody,
      idempotencyKey: privateValues.idempotencyKey,
    },
  });
  expect(messageResponse.statusCode).toBe(201);
  return {
    messageResponse,
    messageId: messageResponse.json<{ id: string }>().id,
    requestIds: [login, denied, messageResponse].map((response) =>
      String(response.headers['x-request-id']),
    ),
  };
}

function captureAuth(
  accountId: string,
  logs: string[],
  privateValues: Fixture['privateValues'] = {
    messageBody: 'unused-message',
    username: 'unused-user',
    password: 'unused-password',
    token: 'U'.repeat(43),
    authorization: 'unused-authorization',
    query: 'unused-query',
    providerError: 'unused-provider-error',
    idempotencyKey: 'unused-idempotency',
  },
): AuthRuntime {
  const timestamp = new Date(0).toISOString();
  return {
    service: {
      authenticate: vi.fn().mockResolvedValue({
        account: {
          id: accountId,
          username: privateValues.username,
          displayName: 'Private Display Name',
        },
        session: {
          id: randomUUID(),
          publicHandle: 'sess_AAAAAAAAAAAAAAAA',
          accountId,
          tokenHash: 'a'.repeat(64),
          credentialVersion: 1,
          createdAt: timestamp,
          lastSeenAt: timestamp,
          recentAuthAt: timestamp,
          expiresAt: new Date(86_400_000).toISOString(),
          idleExpiresAt: new Date(86_400_000).toISOString(),
          revokedAt: null,
        },
      }),
      login: vi
        .fn()
        .mockRejectedValue(new AuthenticationError('authentication_failed')),
    } as never,
    config: {
      trustedOrigin: 'https://chat.example.test',
      secureCookies: false,
      cookieMaxAgeSeconds: 60,
    },
    logStream: { write: (message) => logs.push(message) },
  };
}

function requiredStorage(ready: () => boolean): StorageReadiness {
  return {
    check: () =>
      Promise.resolve({
        ready: ready(),
        storage: 'postgresql' as const,
        schemaVersion: 6,
      }),
  };
}

async function expectPublicHealth(
  app: FastifyInstance,
  url: '/health/live' | '/health/startup' | '/health/ready',
  statusCode: number,
  body: Record<string, string>,
): Promise<void> {
  const response = await app.inject(url);
  expect(response.statusCode).toBe(statusCode);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual(body);
}

function logRecords(logs: string[]): Record<string, unknown>[] {
  return logs
    .flatMap((chunk) => chunk.split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function trackedApp(app: FastifyInstance): FastifyInstance {
  apps.push(app);
  return app;
}

function trackedTelemetry(options: TelemetryOptions = {}): Telemetry {
  const telemetry = new Telemetry(options);
  telemetryInstances.push(telemetry);
  return telemetry;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
