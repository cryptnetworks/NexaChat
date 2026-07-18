import {
  AuthenticationService,
  FixedWindowRateLimiter,
  createArgon2idHasher,
  type PasswordHashParameters,
} from '@nexa/auth';
import { PostgresAuthStore } from '@nexa/postgres';
import type { Pool } from 'pg';
import type { AuthRuntime } from './auth-routes.js';

export function createAuthRuntime(
  pool: Pool,
  environment: NodeJS.ProcessEnv = process.env,
): AuthRuntime {
  const hashing: PasswordHashParameters = {
    memoryKiB: bounded(
      environment.NEXA_ARGON2_MEMORY_KIB,
      19_456,
      19_456,
      262_144,
      'Argon2 memory',
    ),
    passes: bounded(environment.NEXA_ARGON2_PASSES, 2, 2, 10, 'Argon2 passes'),
    parallelism: bounded(
      environment.NEXA_ARGON2_PARALLELISM,
      1,
      1,
      8,
      'Argon2 parallelism',
    ),
    tagLength: bounded(
      environment.NEXA_ARGON2_TAG_LENGTH,
      32,
      16,
      64,
      'Argon2 tag length',
    ),
    saltLength: bounded(
      environment.NEXA_ARGON2_SALT_LENGTH,
      16,
      16,
      64,
      'Argon2 salt length',
    ),
  };
  const absoluteSessionMs =
    bounded(
      environment.NEXA_SESSION_ABSOLUTE_SECONDS,
      604_800,
      300,
      31_536_000,
      'Absolute session lifetime',
    ) * 1000;
  const idleSessionMs =
    bounded(
      environment.NEXA_SESSION_IDLE_SECONDS,
      86_400,
      60,
      604_800,
      'Idle session lifetime',
    ) * 1000;
  if (idleSessionMs > absoluteSessionMs)
    throw new Error(
      'Session idle expiration cannot exceed absolute expiration',
    );
  const production = environment.NODE_ENV === 'production';
  const trustedOrigin = environment.NEXA_WEB_ORIGIN;
  if (!trustedOrigin) throw new Error('NEXA_WEB_ORIGIN is required');
  const parsedOrigin = new URL(trustedOrigin);
  if (
    parsedOrigin.origin !== trustedOrigin ||
    (production && parsedOrigin.protocol !== 'https:')
  )
    throw new Error(
      'NEXA_WEB_ORIGIN must be an exact HTTPS origin in production',
    );
  const secureCookies = production
    ? true
    : environment.NEXA_SECURE_COOKIES === 'true';
  const service = new AuthenticationService(
    new PostgresAuthStore(pool),
    createArgon2idHasher(hashing),
    new FixedWindowRateLimiter(
      bounded(
        environment.NEXA_AUTH_RATE_LIMIT,
        10,
        1,
        1000,
        'Authentication rate limit',
      ),
      bounded(
        environment.NEXA_AUTH_RATE_WINDOW_SECONDS,
        60,
        1,
        3600,
        'Authentication rate window',
      ) * 1000,
    ),
    { now: () => new Date() },
    { absoluteSessionMs, idleSessionMs },
  );
  return {
    service,
    config: {
      trustedOrigin,
      secureCookies,
      cookieMaxAgeSeconds: Math.floor(absoluteSessionMs / 1000),
    },
  };
}

function bounded(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(
      `${name} must be an integer from ${String(minimum)} to ${String(maximum)}`,
    );
  return parsed;
}
