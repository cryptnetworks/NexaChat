import { fileURLToPath } from 'node:url';
import type { PostgresConfig } from '@nexa/postgres';
import type { PasswordHashParameters } from '@nexa/auth';
import type { ObjectStorageConfig } from '@nexa/object-storage';
import type { CoordinationConfig } from '@nexa/coordination';

export type RuntimeMode = 'development' | 'test' | 'production';
export interface RuntimeConfig {
  mode: RuntimeMode;
  server: {
    host: string;
    port: number;
    bodyLimitBytes: number;
    requestTimeoutMs: number;
    shutdownTimeoutMs: number;
    rateLimit: number;
    rateWindowMs: number;
  };
  database: PostgresConfig;
  objectStorage: { enabled: boolean; config?: ObjectStorageConfig };
  coordination: { enabled: boolean; config?: CoordinationConfig };
  webPush: {
    enabled: boolean;
    config?: {
      subject: string;
      publicKey: string;
      privateKey: string;
      encryptionKey: string;
      allowedHosts: string[];
    };
  };
  authentication: {
    trustedOrigin: string;
    secureCookies: boolean;
    absoluteSessionMs: number;
    idleSessionMs: number;
    rateLimit: number;
    rateWindowMs: number;
    hashing: PasswordHashParameters;
  };
  websocket: {
    maxConnections: number;
    maxConnectionsPerAccount: number;
    maxConnectionsPerAddress: number;
    maxSubscriptions: number;
    maxPayloadBytes: number;
    maxBufferedBytes: number;
    maxMessagesPerWindow: number;
    rateWindowMs: number;
    heartbeatMs: number;
    staleMs: number;
    revalidateMs: number;
    drainMs: number;
  };
}

export class ConfigurationError extends Error {
  readonly code = 'invalid_configuration';
  constructor(
    readonly key: string,
    readonly reason: string,
  ) {
    super(`${key}: ${reason}`);
    this.name = 'ConfigurationError';
  }
}

const keys = new Set([
  'NODE_ENV',
  'DATABASE_URL',
  'NEXA_SERVER_HOST',
  'NEXA_SERVER_PORT',
  'NEXA_SERVER_BODY_LIMIT_BYTES',
  'NEXA_SERVER_REQUEST_TIMEOUT_MS',
  'NEXA_SERVER_SHUTDOWN_TIMEOUT_MS',
  'NEXA_SERVER_RATE_LIMIT',
  'NEXA_SERVER_RATE_WINDOW_SECONDS',
  'NEXA_WEB_ORIGIN',
  'NEXA_SECURE_COOKIES',
  'NEXA_SESSION_ABSOLUTE_SECONDS',
  'NEXA_SESSION_IDLE_SECONDS',
  'NEXA_AUTH_RATE_LIMIT',
  'NEXA_AUTH_RATE_WINDOW_SECONDS',
  'NEXA_ARGON2_MEMORY_KIB',
  'NEXA_ARGON2_PASSES',
  'NEXA_ARGON2_PARALLELISM',
  'NEXA_ARGON2_TAG_LENGTH',
  'NEXA_ARGON2_SALT_LENGTH',
  'NEXA_DATABASE_POOL_MAX',
  'NEXA_DATABASE_CONNECT_TIMEOUT_MS',
  'NEXA_DATABASE_IDLE_TIMEOUT_MS',
  'NEXA_DATABASE_QUERY_TIMEOUT_MS',
  'NEXA_MIGRATIONS_DIR',
  'NEXA_ENABLE_DEV_AUTH',
  'NEXA_OBJECT_STORAGE_ENABLED',
  'NEXA_OBJECT_STORAGE_CREATE_BUCKET',
  'NEXA_OBJECT_STORAGE_MAX_BYTES',
  'NEXA_OBJECT_STORAGE_TIMEOUT_MS',
  'NEXA_OBJECT_STORAGE_CLEANUP_PAGE_SIZE',
  'NEXA_COORDINATION_ENABLED',
  'NEXA_COORDINATION_NAMESPACE',
  'NEXA_COORDINATION_OPERATION_TIMEOUT_MS',
  'NEXA_COORDINATION_CONNECT_TIMEOUT_MS',
  'NEXA_COORDINATION_CIRCUIT_FAILURES',
  'NEXA_COORDINATION_CIRCUIT_RESET_MS',
  'NEXA_COORDINATION_MAX_VALUE_BYTES',
  'NEXA_COORDINATION_MAX_TTL_SECONDS',
  'NEXA_WEB_PUSH_ENABLED',
  'NEXA_WEB_PUSH_SUBJECT',
  'NEXA_WEB_PUSH_PUBLIC_KEY',
  'NEXA_WEB_PUSH_PRIVATE_KEY',
  'NEXA_WEB_PUSH_ENCRYPTION_KEY',
  'NEXA_WEB_PUSH_ALLOWED_HOSTS',
  'NEXA_WS_MAX_CONNECTIONS',
  'NEXA_WS_MAX_CONNECTIONS_PER_ACCOUNT',
  'NEXA_WS_MAX_CONNECTIONS_PER_ADDRESS',
  'NEXA_WS_MAX_SUBSCRIPTIONS',
  'NEXA_WS_MAX_PAYLOAD_BYTES',
  'NEXA_WS_MAX_BUFFERED_BYTES',
  'NEXA_WS_RATE_LIMIT',
  'NEXA_WS_RATE_WINDOW_SECONDS',
  'NEXA_WS_HEARTBEAT_SECONDS',
  'NEXA_WS_STALE_SECONDS',
  'NEXA_WS_REVALIDATE_SECONDS',
  'NEXA_WS_DRAIN_SECONDS',
]);

export function parseRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  for (const key of Object.keys(env)
    .filter((key) => key.startsWith('NEXA_'))
    .sort())
    if (!keys.has(key)) fail(key, 'is unknown or no longer supported');
  const mode = choice(env.NODE_ENV ?? 'development', 'NODE_ENV', [
    'development',
    'test',
    'production',
  ] as const);
  const connectionString = required(env, 'DATABASE_URL');
  const databaseUrl = url(connectionString, 'DATABASE_URL');
  if (
    databaseUrl.protocol !== 'postgres:' &&
    databaseUrl.protocol !== 'postgresql:'
  )
    fail('DATABASE_URL', 'must use the postgres or postgresql scheme');
  const trustedOrigin = origin(
    required(env, 'NEXA_WEB_ORIGIN'),
    'NEXA_WEB_ORIGIN',
  );
  if (mode === 'production' && !trustedOrigin.startsWith('https:'))
    fail('NEXA_WEB_ORIGIN', 'must use HTTPS in production');
  const secureCookies = bool(
    env.NEXA_SECURE_COOKIES,
    mode === 'production',
    'NEXA_SECURE_COOKIES',
  );
  if (mode === 'production' && !secureCookies)
    fail('NEXA_SECURE_COOKIES', 'cannot be disabled in production');
  const absolute = int(
    env.NEXA_SESSION_ABSOLUTE_SECONDS,
    604_800,
    300,
    31_536_000,
    'NEXA_SESSION_ABSOLUTE_SECONDS',
  );
  const idle = int(
    env.NEXA_SESSION_IDLE_SECONDS,
    86_400,
    60,
    604_800,
    'NEXA_SESSION_IDLE_SECONDS',
  );
  if (idle > absolute)
    fail(
      'NEXA_SESSION_IDLE_SECONDS',
      'cannot exceed NEXA_SESSION_ABSOLUTE_SECONDS',
    );
  const devIdentity = bool(
    env.NEXA_ENABLE_DEV_AUTH,
    false,
    'NEXA_ENABLE_DEV_AUTH',
  );
  if (mode !== 'development' && devIdentity)
    fail('NEXA_ENABLE_DEV_AUTH', 'is supported only in development');
  const objectStorageEnabled = bool(
    env.NEXA_OBJECT_STORAGE_ENABLED,
    false,
    'NEXA_OBJECT_STORAGE_ENABLED',
  );
  const storageEndpoint = objectStorageEnabled
    ? required(env, 'S3_ENDPOINT')
    : undefined;
  if (objectStorageEnabled && mode === 'production') {
    const parsed = url(
      storageEndpoint ?? fail('S3_ENDPOINT', 'is required'),
      'S3_ENDPOINT',
    );
    if (parsed.protocol !== 'https:')
      fail('S3_ENDPOINT', 'must use HTTPS in production');
  }
  const createBucket = bool(
    env.NEXA_OBJECT_STORAGE_CREATE_BUCKET,
    mode === 'development',
    'NEXA_OBJECT_STORAGE_CREATE_BUCKET',
  );
  if (objectStorageEnabled && mode === 'production' && createBucket)
    fail(
      'NEXA_OBJECT_STORAGE_CREATE_BUCKET',
      'cannot be enabled in production',
    );
  const coordinationEnabled = bool(
    env.NEXA_COORDINATION_ENABLED,
    false,
    'NEXA_COORDINATION_ENABLED',
  );
  const coordinationUrl = coordinationEnabled
    ? required(env, 'REDIS_URL')
    : undefined;
  if (
    coordinationEnabled &&
    mode === 'production' &&
    url(coordinationUrl ?? fail('REDIS_URL', 'is required'), 'REDIS_URL')
      .protocol !== 'rediss:'
  )
    fail('REDIS_URL', 'must use TLS in production');
  const webPushEnabled = bool(
    env.NEXA_WEB_PUSH_ENABLED,
    false,
    'NEXA_WEB_PUSH_ENABLED',
  );
  const webPushSubject = webPushEnabled
    ? required(env, 'NEXA_WEB_PUSH_SUBJECT')
    : undefined;
  if (
    webPushSubject &&
    !webPushSubject.startsWith('mailto:') &&
    !webPushSubject.startsWith('https://')
  )
    fail('NEXA_WEB_PUSH_SUBJECT', 'must use mailto or HTTPS');
  const webPushEncryptionKey = webPushEnabled
    ? required(env, 'NEXA_WEB_PUSH_ENCRYPTION_KEY')
    : undefined;
  if (
    webPushEncryptionKey &&
    Buffer.from(webPushEncryptionKey, 'base64url').length !== 32
  )
    fail('NEXA_WEB_PUSH_ENCRYPTION_KEY', 'must encode exactly 32 bytes');
  const webPushAllowedHosts = webPushEnabled
    ? required(env, 'NEXA_WEB_PUSH_ALLOWED_HOSTS')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    : [];
  if (
    webPushAllowedHosts.length > 32 ||
    webPushAllowedHosts.some(
      (value) =>
        !/^(?:\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value) ||
        !value.includes('.'),
    )
  )
    fail('NEXA_WEB_PUSH_ALLOWED_HOSTS', 'must contain at most 32 DNS suffixes');
  return {
    mode,
    server: {
      host: env.NEXA_SERVER_HOST ?? '0.0.0.0',
      port: int(env.NEXA_SERVER_PORT, 3000, 1, 65_535, 'NEXA_SERVER_PORT'),
      bodyLimitBytes: int(
        env.NEXA_SERVER_BODY_LIMIT_BYTES,
        16_384,
        1_024,
        1_048_576,
        'NEXA_SERVER_BODY_LIMIT_BYTES',
      ),
      requestTimeoutMs: int(
        env.NEXA_SERVER_REQUEST_TIMEOUT_MS,
        15_000,
        1_000,
        120_000,
        'NEXA_SERVER_REQUEST_TIMEOUT_MS',
      ),
      shutdownTimeoutMs: int(
        env.NEXA_SERVER_SHUTDOWN_TIMEOUT_MS,
        10_000,
        1_000,
        60_000,
        'NEXA_SERVER_SHUTDOWN_TIMEOUT_MS',
      ),
      rateLimit: int(
        env.NEXA_SERVER_RATE_LIMIT,
        1_000,
        10,
        1_000_000,
        'NEXA_SERVER_RATE_LIMIT',
      ),
      rateWindowMs:
        int(
          env.NEXA_SERVER_RATE_WINDOW_SECONDS,
          60,
          1,
          3_600,
          'NEXA_SERVER_RATE_WINDOW_SECONDS',
        ) * 1_000,
    },
    database: {
      connectionString,
      maxConnections: int(
        env.NEXA_DATABASE_POOL_MAX,
        10,
        1,
        50,
        'NEXA_DATABASE_POOL_MAX',
      ),
      connectionTimeoutMs: int(
        env.NEXA_DATABASE_CONNECT_TIMEOUT_MS,
        5_000,
        100,
        60_000,
        'NEXA_DATABASE_CONNECT_TIMEOUT_MS',
      ),
      idleTimeoutMs: int(
        env.NEXA_DATABASE_IDLE_TIMEOUT_MS,
        30_000,
        1_000,
        300_000,
        'NEXA_DATABASE_IDLE_TIMEOUT_MS',
      ),
      queryTimeoutMs: int(
        env.NEXA_DATABASE_QUERY_TIMEOUT_MS,
        5_000,
        100,
        60_000,
        'NEXA_DATABASE_QUERY_TIMEOUT_MS',
      ),
      migrationsDirectory:
        env.NEXA_MIGRATIONS_DIR ??
        fileURLToPath(new URL('../migrations', import.meta.url)),
    },
    objectStorage: {
      enabled: objectStorageEnabled,
      ...(objectStorageEnabled
        ? {
            config: {
              endpoint: storageEndpoint ?? fail('S3_ENDPOINT', 'is required'),
              region: env.S3_REGION ?? 'us-east-1',
              accessKeyId: required(env, 'S3_ACCESS_KEY'),
              secretAccessKey: required(env, 'S3_SECRET_KEY'),
              bucket: required(env, 'S3_BUCKET'),
              forcePathStyle: true,
              createBucket,
              maxObjectBytes: int(
                env.NEXA_OBJECT_STORAGE_MAX_BYTES,
                26_214_400,
                1,
                104_857_600,
                'NEXA_OBJECT_STORAGE_MAX_BYTES',
              ),
              operationTimeoutMs: int(
                env.NEXA_OBJECT_STORAGE_TIMEOUT_MS,
                5_000,
                100,
                60_000,
                'NEXA_OBJECT_STORAGE_TIMEOUT_MS',
              ),
              cleanupPageSize: int(
                env.NEXA_OBJECT_STORAGE_CLEANUP_PAGE_SIZE,
                100,
                1,
                1_000,
                'NEXA_OBJECT_STORAGE_CLEANUP_PAGE_SIZE',
              ),
            },
          }
        : {}),
    },
    coordination: {
      enabled: coordinationEnabled,
      ...(coordinationEnabled
        ? {
            config: {
              url: coordinationUrl ?? fail('REDIS_URL', 'is required'),
              namespace: env.NEXA_COORDINATION_NAMESPACE ?? 'nexa',
              operationTimeoutMs: int(
                env.NEXA_COORDINATION_OPERATION_TIMEOUT_MS,
                250,
                10,
                10_000,
                'NEXA_COORDINATION_OPERATION_TIMEOUT_MS',
              ),
              connectTimeoutMs: int(
                env.NEXA_COORDINATION_CONNECT_TIMEOUT_MS,
                2_000,
                100,
                60_000,
                'NEXA_COORDINATION_CONNECT_TIMEOUT_MS',
              ),
              circuitFailures: int(
                env.NEXA_COORDINATION_CIRCUIT_FAILURES,
                3,
                1,
                100,
                'NEXA_COORDINATION_CIRCUIT_FAILURES',
              ),
              circuitResetMs: int(
                env.NEXA_COORDINATION_CIRCUIT_RESET_MS,
                5_000,
                100,
                300_000,
                'NEXA_COORDINATION_CIRCUIT_RESET_MS',
              ),
              maxValueBytes: int(
                env.NEXA_COORDINATION_MAX_VALUE_BYTES,
                65_536,
                1,
                1_048_576,
                'NEXA_COORDINATION_MAX_VALUE_BYTES',
              ),
              maxTtlSeconds: int(
                env.NEXA_COORDINATION_MAX_TTL_SECONDS,
                86_400,
                1,
                2_592_000,
                'NEXA_COORDINATION_MAX_TTL_SECONDS',
              ),
            },
          }
        : {}),
    },
    webPush: {
      enabled: webPushEnabled,
      ...(webPushEnabled
        ? {
            config: {
              subject:
                webPushSubject ?? fail('NEXA_WEB_PUSH_SUBJECT', 'is required'),
              publicKey: required(env, 'NEXA_WEB_PUSH_PUBLIC_KEY'),
              privateKey: required(env, 'NEXA_WEB_PUSH_PRIVATE_KEY'),
              encryptionKey:
                webPushEncryptionKey ??
                fail('NEXA_WEB_PUSH_ENCRYPTION_KEY', 'is required'),
              allowedHosts: webPushAllowedHosts,
            },
          }
        : {}),
    },
    authentication: {
      trustedOrigin,
      secureCookies,
      absoluteSessionMs: absolute * 1000,
      idleSessionMs: idle * 1000,
      rateLimit: int(
        env.NEXA_AUTH_RATE_LIMIT,
        10,
        1,
        1_000,
        'NEXA_AUTH_RATE_LIMIT',
      ),
      rateWindowMs:
        int(
          env.NEXA_AUTH_RATE_WINDOW_SECONDS,
          60,
          1,
          3_600,
          'NEXA_AUTH_RATE_WINDOW_SECONDS',
        ) * 1000,
      hashing: {
        memoryKiB: int(
          env.NEXA_ARGON2_MEMORY_KIB,
          19_456,
          19_456,
          262_144,
          'NEXA_ARGON2_MEMORY_KIB',
        ),
        passes: int(env.NEXA_ARGON2_PASSES, 2, 2, 10, 'NEXA_ARGON2_PASSES'),
        parallelism: int(
          env.NEXA_ARGON2_PARALLELISM,
          1,
          1,
          8,
          'NEXA_ARGON2_PARALLELISM',
        ),
        tagLength: int(
          env.NEXA_ARGON2_TAG_LENGTH,
          32,
          16,
          64,
          'NEXA_ARGON2_TAG_LENGTH',
        ),
        saltLength: int(
          env.NEXA_ARGON2_SALT_LENGTH,
          16,
          16,
          64,
          'NEXA_ARGON2_SALT_LENGTH',
        ),
      },
    },
    websocket: {
      maxConnections: int(
        env.NEXA_WS_MAX_CONNECTIONS,
        1_000,
        1,
        100_000,
        'NEXA_WS_MAX_CONNECTIONS',
      ),
      maxConnectionsPerAccount: int(
        env.NEXA_WS_MAX_CONNECTIONS_PER_ACCOUNT,
        5,
        1,
        100,
        'NEXA_WS_MAX_CONNECTIONS_PER_ACCOUNT',
      ),
      maxConnectionsPerAddress: int(
        env.NEXA_WS_MAX_CONNECTIONS_PER_ADDRESS,
        20,
        1,
        1_000,
        'NEXA_WS_MAX_CONNECTIONS_PER_ADDRESS',
      ),
      maxSubscriptions: int(
        env.NEXA_WS_MAX_SUBSCRIPTIONS,
        32,
        1,
        1_000,
        'NEXA_WS_MAX_SUBSCRIPTIONS',
      ),
      maxPayloadBytes: int(
        env.NEXA_WS_MAX_PAYLOAD_BYTES,
        16_384,
        1_024,
        1_048_576,
        'NEXA_WS_MAX_PAYLOAD_BYTES',
      ),
      maxBufferedBytes: int(
        env.NEXA_WS_MAX_BUFFERED_BYTES,
        262_144,
        1_024,
        16_777_216,
        'NEXA_WS_MAX_BUFFERED_BYTES',
      ),
      maxMessagesPerWindow: int(
        env.NEXA_WS_RATE_LIMIT,
        60,
        1,
        10_000,
        'NEXA_WS_RATE_LIMIT',
      ),
      rateWindowMs:
        int(
          env.NEXA_WS_RATE_WINDOW_SECONDS,
          10,
          1,
          3_600,
          'NEXA_WS_RATE_WINDOW_SECONDS',
        ) * 1_000,
      heartbeatMs:
        int(
          env.NEXA_WS_HEARTBEAT_SECONDS,
          15,
          1,
          300,
          'NEXA_WS_HEARTBEAT_SECONDS',
        ) * 1_000,
      staleMs:
        int(env.NEXA_WS_STALE_SECONDS, 45, 2, 900, 'NEXA_WS_STALE_SECONDS') *
        1_000,
      revalidateMs:
        int(
          env.NEXA_WS_REVALIDATE_SECONDS,
          5,
          1,
          300,
          'NEXA_WS_REVALIDATE_SECONDS',
        ) * 1_000,
      drainMs:
        int(env.NEXA_WS_DRAIN_SECONDS, 5, 1, 60, 'NEXA_WS_DRAIN_SECONDS') *
        1_000,
    },
  };
}

export function safeConfigurationDiagnostic(error: unknown) {
  return error instanceof ConfigurationError
    ? { code: error.code, key: error.key, reason: error.reason }
    : {
        code: 'invalid_configuration',
        key: 'runtime',
        reason: 'configuration could not be loaded',
      };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value?.trim()) fail(key, 'is required and cannot be empty');
  return value;
}
function int(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  key: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    fail(key, `must be an integer from ${String(min)} to ${String(max)}`);
  return parsed;
}
function bool(
  value: string | undefined,
  fallback: boolean,
  key: string,
): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fail(key, 'must be true or false');
}
function choice<const T extends readonly string[]>(
  value: string,
  key: string,
  allowed: T,
): T[number] {
  if (!allowed.includes(value))
    fail(key, `must be one of: ${allowed.join(', ')}`);
  return value;
}
function url(value: string, key: string): URL {
  try {
    return new URL(value);
  } catch {
    return fail(key, 'must be an absolute URL');
  }
}
function origin(value: string, key: string): string {
  const parsed = url(value, key);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value)
    fail(key, 'must be an exact HTTP or HTTPS origin without a path');
  return parsed.origin;
}
function fail(key: string, reason: string): never {
  throw new ConfigurationError(key, reason);
}
