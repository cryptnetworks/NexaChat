import {
  AuthenticationService,
  FixedWindowRateLimiter,
  createArgon2idHasher,
} from '@nexa/auth';
import { PostgresAuthStore } from '@nexa/postgres';
import type { Pool } from 'pg';
import type { AuthRuntime } from './auth-routes.js';
import type { RuntimeConfig } from './config.js';

export function createAuthRuntime(
  pool: Pool,
  config: RuntimeConfig['authentication'],
): AuthRuntime {
  return {
    service: new AuthenticationService(
      new PostgresAuthStore(pool),
      createArgon2idHasher(config.hashing),
      new FixedWindowRateLimiter(config.rateLimit, config.rateWindowMs),
      { now: () => new Date() },
      {
        absoluteSessionMs: config.absoluteSessionMs,
        idleSessionMs: config.idleSessionMs,
      },
    ),
    config: {
      trustedOrigin: config.trustedOrigin,
      secureCookies: config.secureCookies,
      cookieMaxAgeSeconds: Math.floor(config.absoluteSessionMs / 1000),
    },
  };
}
