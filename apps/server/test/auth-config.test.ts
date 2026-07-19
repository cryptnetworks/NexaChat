import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createAuthRuntime } from '../src/auth-config.js';

const pool = new Pool({ connectionString: 'postgresql://unused' });
afterAll(() => pool.end());

describe('authentication configuration', () => {
  it('forces secure cookies and HTTPS origins in production', () => {
    const runtime = createAuthRuntime(pool, {
      NODE_ENV: 'production',
      NEXA_WEB_ORIGIN: 'https://chat.example.test',
      NEXA_SECURE_COOKIES: 'false',
    });
    expect(runtime.config.secureCookies).toBe(true);
    expect(() =>
      createAuthRuntime(pool, {
        NODE_ENV: 'production',
        NEXA_WEB_ORIGIN: 'http://localhost:5173',
      }),
    ).toThrow('exact HTTPS origin');
  });

  it('rejects unsafe hashing, session, and rate-limit parameters', () => {
    const base = {
      NODE_ENV: 'development',
      NEXA_WEB_ORIGIN: 'http://localhost:5173',
    };
    expect(() =>
      createAuthRuntime(pool, { ...base, NEXA_ARGON2_MEMORY_KIB: '1' }),
    ).toThrow();
    expect(() =>
      createAuthRuntime(pool, { ...base, NEXA_SESSION_IDLE_SECONDS: '999999' }),
    ).toThrow();
    expect(() =>
      createAuthRuntime(pool, { ...base, NEXA_AUTH_RATE_LIMIT: '0' }),
    ).toThrow();
  });
});
