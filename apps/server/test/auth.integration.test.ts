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
    expect(JSON.stringify(sessions.json())).not.toMatch(
      /"id"|token|address|location|user.?agent/iu,
    );
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

  it('revokes owned sessions by public handle and preserves the current session', async () => {
    const app = buildApp(undefined, undefined, runtime(pool, true));
    const first = await register(app, 'inventory-owner');
    const accountId = first.response.json<{ id: string }>().id;
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin },
      payload: { username: 'inventory-owner', password },
    });
    const secondCookie = cookie(secondResponse);
    const thirdResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin },
      payload: { username: 'inventory-owner', password },
    });
    const thirdCookie = cookie(thirdResponse);
    const secondHandle = await currentHandle(app, secondCookie);
    const thirdHandle = await currentHandle(app, thirdCookie);
    expect(secondHandle).toMatch(/^sess_/u);
    expect(thirdHandle).not.toBe(secondHandle);

    const outsider = await register(app, 'inventory-outsider');
    const privateAttempt = await app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${encodeURIComponent(secondHandle)}`,
      headers: {
        cookie: outsider.cookie,
        origin,
        'x-nexa-csrf': '1',
      },
    });
    expect(privateAttempt.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/account',
          headers: { cookie: secondCookie },
        })
      ).statusCode,
    ).toBe(200);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${encodeURIComponent(secondHandle)}`,
      headers: { cookie: thirdCookie, origin, 'x-nexa-csrf': '1' },
    });
    expect(revoked.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/account',
          headers: { cookie: secondCookie },
        })
      ).statusCode,
    ).toBe(401);

    const revokeOthers = await app.inject({
      method: 'POST',
      url: '/v1/sessions/revoke-others',
      headers: { cookie: thirdCookie, origin, 'x-nexa-csrf': '1' },
    });
    expect(revokeOthers.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/account',
          headers: { cookie: first.cookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/account',
          headers: { cookie: thirdCookie },
        })
      ).statusCode,
    ).toBe(200);
    const remaining = await app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { cookie: thirdCookie },
    });
    const remainingSessions =
      remaining.json<Array<{ handle: string; current: boolean }>>();
    expect(remainingSessions).toHaveLength(1);
    expect(remainingSessions[0]).toMatchObject({
      handle: thirdHandle,
      current: true,
    });
    const evidence = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events
       WHERE target_type = 'account' AND target_id = $1
       ORDER BY chain_index`,
      [accountId],
    );
    expect(evidence.rows.map((row) => row.action)).toEqual([
      'account.session.revoke',
      'account.sessions.revoke_others',
    ]);
    expect(JSON.stringify(evidence.rows)).not.toMatch(
      /sess_|token|cookie|address|location/iu,
    );
    await app.close();
  });

  it('bounds the PostgreSQL session inventory while retaining the current session', async () => {
    const app = buildApp(undefined, undefined, runtime(pool, true));
    const registered = await register(app, 'bounded-inventory');
    const accountId = registered.response.json<{ id: string }>().id;
    await pool.query(
      `INSERT INTO sessions
        (id, account_id, token_hash, public_handle, credential_version,
         created_at, last_seen_at, recent_auth_at, expires_at, idle_expires_at,
         revoked_at)
       SELECT gen_random_uuid(), $1,
         encode(digest($1::text || ':' || generated.value::text, 'sha256'), 'hex'),
         'sess_' || substr(
           encode(digest('public:' || $1::text || ':' || generated.value::text,
             'sha256'), 'hex'), 1, 24
         ),
         accounts.credential_version,
         CURRENT_TIMESTAMP - generated.value * interval '1 minute',
         CURRENT_TIMESTAMP - generated.value * interval '1 minute',
         CURRENT_TIMESTAMP - generated.value * interval '1 minute',
         CURRENT_TIMESTAMP + interval '1 day',
         CURRENT_TIMESTAMP + interval '1 hour',
         NULL
       FROM generate_series(1, 105) AS generated(value)
       JOIN accounts ON accounts.id = $1`,
      [accountId],
    );

    const response = await app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { cookie: registered.cookie },
    });
    const sessions = response.json<Array<{ current: boolean }>>();
    expect(response.statusCode).toBe(200);
    expect(sessions).toHaveLength(100);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);
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
    const accountId = one.response.json<{ id: string }>().id;
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
    const evidence = await pool.query<{
      notification_type: string;
      action: string;
    }>(
      `SELECT n.notification_type, a.action
         FROM security_notifications n
         JOIN audit_events a ON a.id = n.id
        WHERE n.account_id = $1`,
      [accountId],
    );
    expect(evidence.rows).toEqual([
      {
        notification_type: 'sessions_revoked',
        action: 'account.sessions.revoke_all',
      },
    ]);
    await restarted.close();
  });

  it('atomically changes credentials, rotates every session, and records safe evidence', async () => {
    const app = buildApp(undefined, undefined, runtime(pool, true));
    const registered = await register(app, 'credential-owner');
    const accountId = registered.response.json<{ id: string }>().id;
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin },
      payload: { username: 'credential-owner', password },
    });
    const secondCookie = cookie(login);
    const incorrect = await app.inject({
      method: 'POST',
      url: '/v1/account/password',
      headers: {
        cookie: registered.cookie,
        origin,
        'x-nexa-csrf': '1',
      },
      payload: {
        currentPassword: 'incorrect credential',
        newPassword: 'replacement password number one',
      },
    });
    const reused = await app.inject({
      method: 'POST',
      url: '/v1/account/password',
      headers: {
        cookie: registered.cookie,
        origin,
        'x-nexa-csrf': '1',
      },
      payload: { currentPassword: password, newPassword: password },
    });
    expect(incorrect.statusCode).toBe(401);
    expect(reused.statusCode).toBe(401);
    for (const response of [incorrect, reused])
      expect(response.json()).toMatchObject({
        version: 1,
        error: 'authentication_failed',
        retryable: false,
      });

    const race = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/account/password',
        headers: {
          cookie: registered.cookie,
          origin,
          'x-nexa-csrf': '1',
        },
        payload: {
          currentPassword: password,
          newPassword: 'replacement password number one',
        },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/account/password',
        headers: {
          cookie: secondCookie,
          origin,
          'x-nexa-csrf': '1',
        },
        payload: {
          currentPassword: password,
          newPassword: 'replacement password number two',
        },
      }),
    ]);
    expect(race.map((response) => response.statusCode).sort()).toEqual([
      204, 401,
    ]);
    const success = race.find((response) => response.statusCode === 204);
    if (!success) throw new Error('credential race winner missing');
    const rotatedCookie = cookie(success);
    expect(rotatedCookie).not.toBe('');
    for (const staleCookie of [registered.cookie, secondCookie]) {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/account',
            headers: { cookie: staleCookie },
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/account',
          headers: { cookie: rotatedCookie },
        })
      ).statusCode,
    ).toBe(200);

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin },
      payload: { username: 'credential-owner', password },
    });
    expect(oldLogin.statusCode).toBe(401);
    const notification = await pool.query<{
      notification_type: string;
      correlation_id: string;
    }>(
      `SELECT notification_type, correlation_id::text
         FROM security_notifications
        WHERE account_id = $1`,
      [accountId],
    );
    expect(notification.rows).toHaveLength(1);
    expect(notification.rows[0]?.notification_type).toBe('credentials_changed');
    expect(notification.rows[0]?.correlation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const audit = await pool.query<{
      action: string;
      outcome: string;
      target_type: string;
      target_id: string;
    }>(
      `SELECT action, outcome, target_type, target_id::text
         FROM audit_events
        WHERE target_type = 'account' AND target_id = $1`,
      [accountId],
    );
    expect(audit.rows).toEqual([
      {
        action: 'account.credentials.change',
        outcome: 'succeeded',
        target_type: 'account',
        target_id: accountId,
      },
    ]);
    expect(
      JSON.stringify({ notification: notification.rows, audit: audit.rows }),
    ).not.toMatch(/password|cookie|token|hash/iu);
    await app.close();
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
    const registered = await register(app, 'redaction-owner');
    const newSecretPassword = 'never-log-this-new-password';
    await app.inject({
      method: 'POST',
      url: '/v1/account/password',
      headers: {
        cookie: registered.cookie,
        origin,
        'x-nexa-csrf': '1',
      },
      payload: {
        currentPassword: password,
        newPassword: newSecretPassword,
      },
    });
    expect(logs).not.toContain(secretPassword);
    expect(logs).not.toContain(password);
    expect(logs).not.toContain(newSecretPassword);
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

async function currentHandle(
  app: ReturnType<typeof buildApp>,
  sessionCookie: string,
): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/sessions',
    headers: { cookie: sessionCookie },
  });
  expect(response.statusCode).toBe(200);
  const current = response
    .json<Array<{ handle: string; current: boolean }>>()
    .find((session) => session.current);
  if (!current) throw new Error('current public session handle missing');
  return current.handle;
}
