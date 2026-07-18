import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { initializeDatabase, postgresReadiness } from '../src/database.js';
import { parseRuntimeConfig } from '../src/config.js';
import { createPostgresPool, type PostgresConfig } from '@nexa/postgres';

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
const authenticationConfig = parseRuntimeConfig({
  NODE_ENV: 'development',
  DATABASE_URL: config.connectionString,
  NEXA_WEB_ORIGIN: 'http://localhost:5173',
}).authentication;
process.env.NEXA_WEB_ORIGIN = 'http://localhost:5173';

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
});

afterAll(async () => {
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

describe('PostgreSQL-backed API', () => {
  it('persists the development flow across API restarts', async () => {
    const first = await initializeDatabase(config, authenticationConfig);
    const firstApp = buildApp(first.service, first.readiness, first.auth);
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
    const communityResponse = await firstApp.inject({
      method: 'POST',
      url: '/v1/communities',
      payload: { ownerId: account.id, name: 'Persistent' },
    });
    const community = communityResponse.json<{ id: string }>();
    const spaceResponse = await firstApp.inject({
      method: 'POST',
      url: `/v1/communities/${community.id}/spaces`,
      payload: { actorId: account.id, name: 'general' },
    });
    const space = spaceResponse.json<{ id: string }>();
    await firstApp.close();
    await first.pool.end();

    const second = await initializeDatabase(config, authenticationConfig);
    const secondApp = buildApp(second.service, second.readiness, second.auth);
    const message = await secondApp.inject({
      method: 'POST',
      url: `/v1/spaces/${space.id}/messages`,
      payload: { authorId: account.id, body: 'survived restart' },
    });
    expect(message.statusCode).toBe(201);
    expect(message.json()).toMatchObject({ body: 'survived restart' });
    const ready = await secondApp.inject('/health/ready');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'ready',
      storage: 'postgresql',
      schemaVersion: 3,
    });
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
    expect(ready.json()).toEqual({
      status: 'unavailable',
      storage: 'postgresql',
    });
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

  it('fails startup for missing or incompatible migration history', async () => {
    await expect(
      initializeDatabase({
        ...config,
        migrationsDirectory: resolve('packages/postgres/test/empty'),
      }),
    ).rejects.toThrow('Required migration 1 is missing');

    const database = await initializeDatabase(config);
    await database.pool.query(
      "UPDATE nexa_schema_migrations SET checksum = repeat('0', 64) WHERE version = 1",
    );
    await database.pool.end();
    await expect(initializeDatabase(config)).rejects.toThrow(
      'Applied migration 1 is incompatible',
    );
  });
});
