import {
  AuthenticationService,
  FixedWindowRateLimiter,
  DistributedRecoveryRateLimiter,
  RecoveryService,
  createArgon2idHasher,
} from '@nexa/auth';
import { PostgresAuthStore, PostgresRecoveryStore } from '@nexa/postgres';
import type { Pool } from 'pg';
import type { EphemeralCoordination } from '@nexa/coordination';
import type { AuthRuntime } from './auth-routes.js';
import type { RuntimeConfig } from './config.js';

export function createAuthRuntime(
  pool: Pool,
  config: RuntimeConfig['authentication'],
  coordination?: EphemeralCoordination,
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
    recovery: new RecoveryService(
      new PostgresRecoveryStore(pool),
      createArgon2idHasher(config.hashing),
      new DistributedRecoveryRateLimiter(
        coordination,
        config.rateLimit,
        config.rateWindowMs,
      ),
      { now: () => new Date() },
    ),
    config: {
      trustedOrigin: config.trustedOrigin,
      secureCookies: config.secureCookies,
      cookieMaxAgeSeconds: Math.floor(config.absoluteSessionMs / 1000),
    },
  };
}
