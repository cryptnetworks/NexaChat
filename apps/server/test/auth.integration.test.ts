import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthenticationService,
  FixedWindowRateLimiter,
  createArgon2idHasher,
} from '@nexa/auth';
import {
  PostgresAuthStore,
  createPostgresPool,
  migratePostgres,
  type PostgresConfig,
} from '@nexa/postgres';
import { buildApp } from '../src/app.js';
import type { AuthRuntime } from '../src/auth-routes.js';

const adminUrl =
  process.env.DATABASE_TEST_URL ??
  'postgresql://nexa:local-development-password@127.0.0.1:5432/nexa';
const databaseName = `nexa_auth_test_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const config: PostgresConfig = {
  connectionString: databaseUrl.toString(),
  maxConnections: 8,
  connectionTimeoutMs: 2_000,
  idleTimeoutMs: 2_000,
  queryTimeoutMs: 3_000,
  migrationsDirectory: resolve('apps/server/migrations'),
};
const origin = 'https://chat.example.test';
const password = 'correct horse battery staple';
let pool: Pool;
let poolInitialized = false;
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
  pool = createPostgresPool(config);
  poolInitialized = true;
  await migratePostgres(pool, config.migrationsDirectory);
});

afterAll(async () => {
  const cleanupErrors: Error[] = [];
  if (poolInitialized) {
    try {
      await pool.end();
    } catch (error) {
      cleanupErrors.push(asError(error));
    }
  }
  if (databaseCreated) {
    try {
      await withAdminPool(async (admin) => {
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      });
    } catch (error) {
      cleanupErrors.push(asError(error));
    }
  }
  const [firstCleanupError] = cleanupErrors;
  if (cleanupErrors.length === 1 && firstCleanupError) {
    throw firstCleanupError;
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'PostgreSQL cleanup failed');
  }
});

describe('local authentication HTTP lifecycle', () => {
  it('registers, logs in with rotation, retrieves account, lists sessions, and logs out', async () => {
    const app = buildApp(undefined, undefined, runtime(pool, true));
    const registered = await register(app, 'Mira');
    expect(registered.response.statusCode).toBe(201);
    expect(registered.setCookie).toContain('HttpOnly');
    expect(registered.setCookie).toContain('SameSite=Strict');
    expect(registered.setCookie).toContain('Path=/');
    expect(registered.setCookie).toContain('Secure');
    expect(registered.response.json()).toEqual(
      expect.objectContaining({ username: 'Mira' }),
    );
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin },
      payload: { username: 'mira', password },
    });
    const loginCookie = cookie(login);
    expect(login.statusCode).toBe(200);
    expect(loginCookie).not.toBe(registered.cookie);
    const account = await app.inject({
      method: 'GET',
      url: '/v1/account',
      headers: { cookie: loginCookie },
    });
    expect(account.statusCode).toBe(200);
    const sessions = await app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { cookie: loginCookie },
    });
    expect(sessions.json<unknown[]>()).toHaveLength(2);
    expect(
      sessions
        .json<Array<{ current: boolean }>>()
        .filter((item) => item.current),
    ).toHaveLength(1);
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: loginCookie, origin, 'x-nexa-csrf': '1' },
    });
    expect(logout.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/account',
          headers: { cookie: loginCookie },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });

  it('retrieves and atomically updates private-safe account profiles', async () => {
    const app = buildApp(undefined, undefined, runtime(pool, true));
    const first = await register(app, 'ProfileOwner');
    await register(app, 'CollisionOwner');
    const profile = await app.inject({
      method: 'GET',
      url: '/v1/account',
      headers: { cookie: first.cookie },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({
      username: 'ProfileOwner',
      avatar: null,
      version: 1,
    });
    expect(JSON.stringify(profile.json())).not.toMatch(
      /password|credential|normalized|status|token/iu,
    );
    const accountId = profile.json<{ id: string }>().id;
    const accepted = await app.inject({
      method: 'PATCH',
      url: '/v1/account',
      headers: {
        cookie: first.cookie,
        origin,
        'x-nexa-csrf': '1',
      },
      payload: {
        username: '  Profile_Owner  ',
        displayName: '  Profile\t Owner  ',
        avatar: {
          objectKey: `avatars/${accountId}/portrait.webp`,
          mediaType: 'image/webp',
          byteLength: 1024,
          sha256: 'a'.repeat(64),
        },
        expectedVersion: 1,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      username: 'Profile_Owner',
      displayName: 'Profile Owner',
      version: 2,
    });
    const collision = await app.inject({
      method: 'PATCH',
      url: '/v1/account',
      headers: {
        cookie: first.cookie,
        origin,
        'x-nexa-csrf': '1',
      },
      payload: { username: 'collisionowner', expectedVersion: 2 },
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toMatchObject({ error: 'identifier_unavailable' });
    const race = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: '/v1/account',
        headers: {
          cookie: first.cookie,
          origin,
          'x-nexa-csrf': '1',
        },
        payload: { displayName: 'First writer', expectedVersion: 2 },
      }),
      app.inject({
        method: 'PATCH',
        url: '/v1/account',
        headers: {
          cookie: first.cookie,
          origin,
          'x-nexa-csrf': '1',
        },
        payload: { displayName: 'Second writer', expectedVersion: 2 },
      }),
    ]);
    expect(race.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      race.find((response) => response.statusCode === 409)?.json(),
    ).toMatchObject({ error: 'stale_write' });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/v1/account',
          headers: { origin, 'x-nexa-csrf': '1' },
          payload: { displayName: 'No session', expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(401);
    await pool.query("UPDATE accounts SET status = 'suspended' WHERE id = $1", [
      accountId,
    ]);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/v1/account',
          headers: {
            cookie: first.cookie,
            origin,
            'x-nexa-csrf': '1',
          },
          payload: { displayName: 'Suspended', expectedVersion: 3 },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });

  it('revokes all sessions immediately and persists revocation across restart', async () => {
    const first = buildApp(undefined, undefined, runtime(pool, true));
    const one = await register(first, 'revoker');
    const login = await first.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin },
      payload: { username: 'revoker', password },
    });
    const secondCookie = cookie(login);
    const all = await first.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { cookie: one.cookie, origin, 'x-nexa-csrf': '1' },
    });
    expect(all.statusCode).toBe(204);
    await first.close();
    await pool.end();
    pool = createPostgresPool(config);
    const restarted = buildApp(undefined, undefined, runtime(pool, true));
    expect(
      (
        await restarted.inject({
          method: 'GET',
          url: '/v1/account',
          headers: { cookie: secondCookie },
        })
      ).statusCode,
    ).toBe(401);
    await restarted.close();
  });

  it('handles normalized duplicates, registration races, and uniform login failure', async () => {
    const app = buildApp(undefined, undefined, runtime(pool, true));
    await register(app, 'Normalized');
    const duplicate = await register(app, 'normalized');
    expect(duplicate.response.statusCode).toBe(409);
    expect(duplicate.response.json()).toMatchObject({
      error: 'identifier_unavailable',
    });
    const race = await Promise.all([
      register(app, 'RaceUser'),
      register(app, 'raceuser'),
    ]);
    expect(race.map((result) => result.response.statusCode).sort()).toEqual([
      201, 409,
    ]);
    const incorrect = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin },
      payload: { username: 'Normalized', password: 'incorrect credential' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin },
      payload: { username: 'does-not-exist', password: 'incorrect credential' },
    });
    expect(incorrect.statusCode).toBe(unknown.statusCode);
    expect(incorrect.json()).toMatchObject({
      version: 1,
      error: 'authentication_failed',
      retryable: false,
    });
    expect(unknown.json()).toMatchObject({
      version: 1,
      error: 'authentication_failed',
      retryable: false,
    });
    await app.close();
  });

  it('rejects credential boundaries, oversized bodies, CSRF, origins, and malformed tokens', async () => {
    const app = buildApp(undefined, undefined, runtime(pool, true));
    for (const invalidPassword of ['short', 'x'.repeat(129)]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        headers: { origin },
        payload: {
          username: 'boundary',
          displayName: 'Boundary',
          password: invalidPassword,
        },
      });
      expect(response.statusCode).toBe(400);
    }
    const oversized = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { origin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        username: 'large',
        displayName: 'x'.repeat(17_000),
        password,
      }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ error: 'payload_too_large' });
    const created = await register(app, 'csrfuser');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/logout',
          headers: { cookie: created.cookie, origin },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/logout',
          headers: {
            cookie: created.cookie,
            origin: 'https://evil.test',
            'x-nexa-csrf': '1',
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/account',
          headers: { cookie: '__Host-nexa_session=bad' },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });

  it('rejects suspended and credential-reset accounts', async () => {
    const auth = runtime(pool, true);
    const app = buildApp(undefined, undefined, auth);
    const suspended = await register(app, 'suspended');
    const id = suspended.response.json<{ id: string }>().id;
    await pool.query("UPDATE accounts SET status = 'suspended' WHERE id = $1", [
      id,
    ]);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/account',
          headers: { cookie: suspended.cookie },
        })
      ).statusCode,
    ).toBe(401);
    await pool.query("UPDATE accounts SET status = 'active' WHERE id = $1", [
      id,
    ]);
    await auth.service.resetCredentials(id, 'a replacement password');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/account',
          headers: { cookie: suspended.cookie },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });

  it('applies source and identifier limits and fails closed', async () => {
    const limited = buildApp(undefined, undefined, runtime(pool, true, 1));
    await register(limited, 'limited');
    const response = await limited.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin },
      payload: { username: 'limited', password },
    });
    expect(response.statusCode).toBe(429);
    await limited.close();
  });

  it('uses development cookie behavior and never exposes the development endpoint', async () => {
    const app = buildApp(undefined, undefined, runtime(pool, false));
    const created = await register(app, 'localcookie');
    expect(created.setCookie).not.toContain('Secure');
    const development = await app.inject({
      method: 'POST',
      url: '/v1/dev/accounts',
      payload: { displayName: 'unsafe' },
    });
    expect(development.statusCode).toBe(404);
    await app.close();
  });

  it('redacts passwords, tokens, cookies, and authorization headers from logs', async () => {
    let logs = '';
    const auth = runtime(pool, true);
    auth.logStream = {
      write: (message) => {
        logs += message;
      },
    };
    const app = buildApp(undefined, undefined, auth);
    const secretPassword = 'never-log-this-password';
    const rawToken = 'A'.repeat(43);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: {
        origin,
        cookie: `__Host-nexa_session=${rawToken}`,
        authorization: 'Bearer never-log-this-header',
      },
      payload: { username: '', password: secretPassword },
    });
    expect(logs).not.toContain(secretPassword);
    expect(logs).not.toContain(rawToken);
    expect(logs).not.toContain('never-log-this-header');
    await app.close();
  });
});

function runtime(
  poolValue: Pool,
  secureCookies: boolean,
  limit = 50,
): AuthRuntime {
  return {
    service: new AuthenticationService(
      new PostgresAuthStore(poolValue),
      createArgon2idHasher({
        memoryKiB: 19_456,
        passes: 2,
        parallelism: 1,
        tagLength: 32,
        saltLength: 16,
      }),
      new FixedWindowRateLimiter(limit, 60_000),
      { now: () => new Date() },
      { absoluteSessionMs: 604_800_000, idleSessionMs: 86_400_000 },
    ),
    config: {
      trustedOrigin: origin,
      secureCookies,
      cookieMaxAgeSeconds: 604_800,
    },
  };
}

async function register(app: ReturnType<typeof buildApp>, username: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    headers: { origin },
    payload: { username, displayName: username, password },
  });
  return {
    response,
    cookie: cookie(response),
    setCookie:
      typeof response.headers['set-cookie'] === 'string'
        ? response.headers['set-cookie']
        : '',
  };
}

function cookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  return typeof value === 'string' ? (value.split(';')[0] ?? '') : '';
}
