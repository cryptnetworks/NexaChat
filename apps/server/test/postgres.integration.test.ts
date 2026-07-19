import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { initializeDatabase, postgresReadiness } from '../src/database.js';
import { parseRuntimeConfig } from '../src/config.js';
import { Telemetry } from '../src/telemetry.js';
import { createPostgresPool, type PostgresConfig } from '@nexa/postgres';

const traceId = '0af7651916cd43dd8448eb211c80319c';
const parentSpanId = 'b7ad6b7169203331';

const adminUrl =
  process.env.DATABASE_TEST_URL ??
  'postgresql://nexa:local-development-password@127.0.0.1:5432/nexa';
const databaseName = `nexa_api_test_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const config: PostgresConfig = {
  connectionString: databaseUrl.toString(),
  maxConnections: 5,
  connectionTimeoutMs: 1_000,
  idleTimeoutMs: 2_000,
  queryTimeoutMs: 2_000,
  migrationsDirectory: resolve('apps/server/migrations'),
};
const runtimeConfig = parseRuntimeConfig({
  NODE_ENV: 'development',
  DATABASE_URL: config.connectionString,
  NEXA_WEB_ORIGIN: 'http://localhost:5173',
});
let databaseCreated = false;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function withAdminPool(
  operation: (admin: Pool) => Promise<void>,
): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl });
  let operationError: Error | undefined;
  try {
    await operation(admin);
  } catch (error) {
    operationError = asError(error);
  }
  let cleanupError: Error | undefined;
  try {
    await admin.end();
  } catch (error) {
    cleanupError = asError(error);
  }
  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      'PostgreSQL admin operation and cleanup both failed',
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
}

beforeAll(async () => {
  await withAdminPool(async (admin) => {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
  });
});

afterAll(async () => {
  if (databaseCreated) {
    await withAdminPool(async (admin) => {
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    });
  }
});

describe('PostgreSQL-backed API', () => {
  it('persists the development flow across API restarts', async () => {
    const first = await initializeDatabase(
      config,
      runtimeConfig.authentication,
    );
    const firstApp = buildApp(
      first.service,
      first.readiness,
      first.auth,
      first.authorization,
      runtimeConfig.server,
    );
    const accountResponse = await firstApp.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { origin: 'http://localhost:5173' },
      payload: {
        username: 'ada',
        displayName: 'Ada',
        password: 'correct horse battery staple',
      },
    });
    const account = accountResponse.json<{ id: string }>();
    const cookie = accountResponse.headers['set-cookie'];
    expect(cookie).toBeTypeOf('string');
    const csrfRejected = await firstApp.inject({
      method: 'POST',
      url: '/v1/communities',
      headers: { cookie },
      payload: { ownerId: account.id, name: 'Rejected' },
    });
    expect(csrfRejected.statusCode).toBe(403);
    expect(csrfRejected.json()).toMatchObject({ error: 'csrf_rejected' });
    const communityResponse = await firstApp.inject({
      method: 'POST',
      url: '/v1/communities',
      headers: {
        cookie,
        origin: 'http://localhost:5173',
        'x-nexa-csrf': '1',
      },
      payload: { ownerId: account.id, name: 'Persistent' },
    });
    const community = communityResponse.json<{ id: string }>();
    const spaceResponse = await firstApp.inject({
      method: 'POST',
      url: `/v1/communities/${community.id}/spaces`,
      headers: {
        cookie,
        origin: 'http://localhost:5173',
        'x-nexa-csrf': '1',
      },
      payload: { actorId: account.id, name: 'general' },
    });
    const space = spaceResponse.json<{ id: string }>();
    await firstApp.close();
    await first.pool.end();

    const second = await initializeDatabase(
      config,
      runtimeConfig.authentication,
    );
    const secondApp = buildApp(
      second.service,
      second.readiness,
      second.auth,
      second.authorization,
      runtimeConfig.server,
    );
    const message = await secondApp.inject({
      method: 'POST',
      url: `/v1/spaces/${space.id}/messages`,
      headers: {
        cookie,
        origin: 'http://localhost:5173',
        'x-nexa-csrf': '1',
      },
      payload: { authorId: account.id, body: 'survived restart' },
    });
    expect(message.statusCode).toBe(201);
    expect(message.json()).toMatchObject({ body: 'survived restart' });
    const ready = await secondApp.inject('/health/ready');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });
    await secondApp.close();
    await second.pool.end();
  });

  it('reports unavailable storage and fails startup without leaking credentials', async () => {
    const unavailable = createPostgresPool({
      ...config,
      connectionString:
        'postgresql://secret-user:secret-password@127.0.0.1:1/nexa',
      connectionTimeoutMs: 100,
    });
    const app = buildApp(undefined, postgresReadiness(unavailable));
    const ready = await app.inject('/health/ready');
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'unavailable' });
    await app.close();
    await unavailable.end();
    await expect(
      initializeDatabase({
        ...config,
        connectionString:
          'postgresql://secret-user:secret-password@127.0.0.1:1/nexa',
        connectionTimeoutMs: 100,
      }),
    ).rejects.toThrow('PostgreSQL startup failed');
    try {
      await initializeDatabase({
        ...config,
        connectionString:
          'postgresql://secret-user:secret-password@127.0.0.1:1/nexa',
        connectionTimeoutMs: 100,
      });
    } catch (error) {
      expect(String(error)).not.toContain('secret-password');
      expect(String(error)).not.toContain('secret-user');
    }
  });

  it('keeps one sampled trace and correlation identifier across HTTP, PostgreSQL, message, and realtime work', async () => {
    const logs: string[] = [];
    const telemetry = new Telemetry({ traceSampleRate: 1 });
    const database = await initializeDatabase(config, undefined, telemetry);
    const owner = await database.service.createAccount('Trace Owner');
    const community = await database.service.createCommunity(
      owner.id,
      'Trace Community',
    );
    const space = await database.service.createTextSpace(
      community.id,
      owner.id,
      'trace-space',
    );
    const app = buildApp(
      database.service,
      database.readiness,
      {
        service: {
          authenticate: vi.fn(),
        } as never,
        config: {
          trustedOrigin: runtimeConfig.authentication.trustedOrigin,
          secureCookies: runtimeConfig.authentication.secureCookies,
          cookieMaxAgeSeconds: 60,
        },
        logStream: { write: (message) => logs.push(message) },
      },
      undefined,
      runtimeConfig.server,
      telemetry,
    );
    const broadcast = vi.fn();
    app.websocketHub = {
      broadcast,
      close: () => Promise.resolve(),
    };

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/spaces/${space.id}/messages`,
        headers: {
          traceparent: `00-${traceId}-${parentSpanId}-01`,
        },
        payload: {
          authorId: owner.id,
          body: 'privacy-safe trace fixture',
          idempotencyKey: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(201);
      const correlationId = String(response.headers['x-request-id']);
      const records = logRecords(logs).filter(
        (record) => record.event === 'trace.span.completed',
      );

      for (const operation of [
        'http.request',
        'message.command',
        'postgres.query',
        'realtime.publish',
      ]) {
        expect(records).toContainEqual(
          expect.objectContaining({
            event: 'trace.span.completed',
            operation,
            outcome: 'success',
            correlationId,
            traceId,
          }),
        );
      }
      expect(broadcast).toHaveBeenCalledOnce();
      expect(JSON.stringify(records)).not.toContain(owner.id);
      expect(JSON.stringify(records)).not.toContain(community.id);
      expect(JSON.stringify(records)).not.toContain(space.id);
      expect(JSON.stringify(records)).not.toContain(
        'privacy-safe trace fixture',
      );
    } finally {
      await app.close();
      await database.pool.end();
      telemetry.stopProcessCollection();
    }
  });

  it('fails startup for missing or incompatible migration history', async () => {
    await expect(
      initializeDatabase({
        ...config,
        migrationsDirectory: resolve('packages/postgres/test/empty'),
      }),
    ).rejects.toThrow('PostgreSQL startup failed');

    const database = await initializeDatabase(config);
    const original = await database.pool.query<{
      name: string;
      checksum: string;
    }>('SELECT name, checksum FROM nexa_schema_migrations WHERE version = 1');
    const expected = original.rows[0];
    if (!expected) throw new Error('missing migration fixture');
    const app = buildApp(undefined, database.readiness);
    await database.pool.query(
      "UPDATE nexa_schema_migrations SET checksum = repeat('0', 64) WHERE version = 1",
    );
    await expect(app.inject('/health/ready')).resolves.toMatchObject({
      statusCode: 503,
    });
    await database.pool.query(
      'UPDATE nexa_schema_migrations SET checksum = $1 WHERE version = 1',
      [expected.checksum],
    );
    await expect(app.inject('/health/ready')).resolves.toMatchObject({
      statusCode: 200,
    });
    await database.pool.query(
      "UPDATE nexa_schema_migrations SET name = '0001_incompatible.sql' WHERE version = 1",
    );
    await expect(app.inject('/health/ready')).resolves.toMatchObject({
      statusCode: 503,
    });
    await database.pool.query(
      "UPDATE nexa_schema_migrations SET name = $1, checksum = repeat('0', 64) WHERE version = 1",
      [expected.name],
    );
    await app.close();
    await database.pool.end();
    await expect(initializeDatabase(config)).rejects.toThrow(
      'PostgreSQL startup failed',
    );
  });
});

function logRecords(logs: readonly string[]): Record<string, unknown>[] {
  return logs
    .flatMap((chunk) => chunk.split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
