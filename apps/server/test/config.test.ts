import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  parseRuntimeConfig,
  safeConfigurationDiagnostic,
} from '../src/config.js';

const development = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://nexa:password@localhost:5432/nexa',
  NEXA_WEB_ORIGIN: 'http://localhost:5173',
};
const production = {
  NODE_ENV: 'production',
  DATABASE_URL:
    'postgresql://nexa:password@db.example.test:5432/nexa?sslmode=verify-full',
  NEXA_PUBLIC_URL: 'https://chat.example.test',
  NEXA_TRUSTED_PROXY_CIDRS: '10.20.0.2/32',
  NEXA_WEB_ORIGIN: 'https://chat.example.test',
  NEXA_SECURE_COOKIES: 'true',
};

describe('runtime configuration', () => {
  it('parses valid development and production settings', () => {
    expect(parseRuntimeConfig(development).mode).toBe('development');
    const config = parseRuntimeConfig(production);
    expect(config.configurationSchemaVersion).toBe(1);
    expect(config.authentication.secureCookies).toBe(true);
    expect(config.database.maxConnections).toBe(10);
    expect(config.websocket.maxSubscriptions).toBe(32);
    expect(config.server.rateLimit).toBe(1_000);
    expect(config.server.trustedProxyCidrs).toEqual(['10.20.0.2/32']);
    expect(config.deployment).toEqual({
      profile: 'standard',
      publicUrl: 'https://chat.example.test',
    });
    expect(config.objectStorage.enabled).toBe(false);
    expect(config.coordination.enabled).toBe(false);
    expect(config.webPush.enabled).toBe(false);
  });

  it('requires explicit bounded web push secrets when enabled', () => {
    const config = parseRuntimeConfig({
      ...development,
      NEXA_WEB_PUSH_ENABLED: 'true',
      NEXA_WEB_PUSH_SUBJECT: 'mailto:operator@example.test',
      NEXA_WEB_PUSH_PUBLIC_KEY: 'public',
      NEXA_WEB_PUSH_PRIVATE_KEY: 'private',
      NEXA_WEB_PUSH_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url'),
      NEXA_WEB_PUSH_ALLOWED_HOSTS: '.example.test',
    });
    expect(config.webPush).toMatchObject({
      enabled: true,
      config: { subject: 'mailto:operator@example.test' },
    });
  });

  it('uses mode-aware observability defaults', () => {
    const developmentConfig = parseRuntimeConfig(development);
    const testConfig = parseRuntimeConfig({
      ...development,
      NODE_ENV: 'test',
    });
    const productionConfig = parseRuntimeConfig(production);

    expect(developmentConfig.server.logLevel).toBe('info');
    expect(testConfig.server.logLevel).toBe('info');
    expect(productionConfig.server.logLevel).toBe('info');
    expect(developmentConfig.observability.traceSampleRate).toBe(1);
    expect(testConfig.observability.traceSampleRate).toBe(1);
    expect(productionConfig.observability.traceSampleRate).toBe(0.01);
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)(
    'accepts the %s log level',
    (logLevel) => {
      expect(
        parseRuntimeConfig({
          ...production,
          NEXA_LOG_LEVEL: logLevel,
        }).server.logLevel,
      ).toBe(logLevel);
    },
  );

  it.each([
    ['0', 0],
    ['0.125', 0.125],
    ['1', 1],
  ])('accepts trace sample rate %s', (value, expected) => {
    expect(
      parseRuntimeConfig({
        ...production,
        NEXA_TRACE_SAMPLE_RATE: value,
      }).observability.traceSampleRate,
    ).toBe(expected);
  });

  it.each([
    ['NEXA_LOG_LEVEL', 'verbose'],
    ['NEXA_TRACE_SAMPLE_RATE', 'NaN'],
    ['NEXA_TRACE_SAMPLE_RATE', 'Infinity'],
    ['NEXA_TRACE_SAMPLE_RATE', '-Infinity'],
    ['NEXA_TRACE_SAMPLE_RATE', '-0.0001'],
    ['NEXA_TRACE_SAMPLE_RATE', '1.0001'],
    ['NEXA_TRACE_SAMPLE_RATE', 'not-a-number-private-value'],
    ['NEXA_TRACE_SAMPLE_RATE', ''],
  ])('rejects invalid %s without exposing its value', (key, value) => {
    try {
      parseRuntimeConfig({ ...development, [key]: value });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const diagnostic = safeConfigurationDiagnostic(error);
      expect(diagnostic.key).toBe(key);
      if (value !== '') {
        expect(error instanceof Error ? error.message : '').not.toContain(
          value,
        );
        expect(JSON.stringify(diagnostic)).not.toContain(value);
      }
    }
  });

  it('rejects unknown observability settings without exposing their values', () => {
    const value = 'private-unsupported-exporter';
    try {
      parseRuntimeConfig({
        ...development,
        NEXA_TELEMETRY_EXPORTER: value,
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const diagnostic = safeConfigurationDiagnostic(error);
      expect(diagnostic.key).toBe('NEXA_TELEMETRY_EXPORTER');
      expect(error instanceof Error ? error.message : '').not.toContain(value);
      expect(JSON.stringify(diagnostic)).not.toContain(value);
    }
  });

  it('parses bounded ephemeral coordination settings', () => {
    const config = parseRuntimeConfig({
      ...development,
      NEXA_COORDINATION_ENABLED: 'true',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(config.coordination.config).toMatchObject({
      namespace: 'nexa',
      operationTimeoutMs: 250,
      maxTtlSeconds: 86_400,
    });
  });

  it('parses enabled object storage without retaining endpoint credentials', () => {
    const config = parseRuntimeConfig({
      ...development,
      NEXA_OBJECT_STORAGE_ENABLED: 'true',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'access',
      S3_SECRET_KEY: 'secret',
      S3_BUCKET: 'private-objects',
    });
    expect(config.objectStorage.config).toMatchObject({
      endpoint: 'http://localhost:9000',
      bucket: 'private-objects',
      createBucket: true,
      forcePathStyle: true,
    });
  });

  it('permits plaintext providers only for exact single-host-private service endpoints', () => {
    const config = parseRuntimeConfig({
      ...production,
      DATABASE_URL: 'postgresql://nexa:password@postgres:5432/nexa',
      NEXA_DEPLOYMENT_PROFILE: 'single-host-private',
      NEXA_COORDINATION_ENABLED: 'true',
      REDIS_URL: 'redis://:coordination-secret@valkey:6379',
      NEXA_OBJECT_STORAGE_ENABLED: 'true',
      NEXA_OBJECT_STORAGE_CREATE_BUCKET: 'false',
      S3_ENDPOINT: 'http://object-storage:8333',
      S3_ACCESS_KEY: 'access',
      S3_SECRET_KEY: 'secret',
      S3_BUCKET: 'private-objects',
    });

    expect(config.deployment.profile).toBe('single-host-private');
    expect(config.database.connectionString).toContain('@postgres:5432/');
    expect(config.coordination.config?.url).toContain('@valkey:6379');
    expect(config.objectStorage.config?.endpoint).toBe(
      'http://object-storage:8333',
    );
  });

  it.each([
    'https://localhost.',
    'https://gateway.localhost.',
    'https://127.0.0.2',
    'https://[::1]',
    'https://[::ffff:7f00:1]',
  ])('rejects local production public origin %s', (publicUrl) => {
    expect(() =>
      parseRuntimeConfig({
        ...production,
        NEXA_PUBLIC_URL: publicUrl,
        NEXA_WEB_ORIGIN: publicUrl,
      }),
    ).toThrow(
      expect.objectContaining({
        key: 'NEXA_PUBLIC_URL',
        reason: 'must not use a local hostname in production',
      }),
    );
  });

  it.each([
    '',
    '?sslmode=disable',
    '?sslmode=prefer',
    '?sslmode=require',
    '?sslmode=verify-ca',
    '?sslmode=no-verify',
    '?sslmode=verify-full&sslmode=verify-full',
    '?sslmode=verify-full&sslmode=no-verify',
    '?sslmode=verify-full&uselibpqcompat=true',
    '?sslmode=verify-full&uselibpqcompat=false',
    '?sslmode=verify-full&ssl=0',
    '?sslmode=verify-full&ssl=true',
    '?sslmode=verify-full&sslrootcert=/first&sslrootcert=/second',
    '?sslmode=verify-full&sslrootcert=',
    '?SSLMODE=verify-full',
  ])('rejects unsafe or ambiguous PostgreSQL TLS query %s', (query) => {
    const databaseUrl = `postgresql://nexa:private-database-secret@db.example.test:5432/nexa${query}`;
    try {
      parseRuntimeConfig({ ...production, DATABASE_URL: databaseUrl });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const diagnostic = safeConfigurationDiagnostic(error);
      expect(diagnostic.key).toBe('DATABASE_URL');
      expect(JSON.stringify(diagnostic)).not.toContain(
        'private-database-secret',
      );
    }
  });

  it('accepts explicit full PostgreSQL certificate verification options', () => {
    const config = parseRuntimeConfig({
      ...production,
      DATABASE_URL:
        'postgresql://nexa:password@db.example.test:5432/nexa?sslmode=verify-full&sslrootcert=%2Frun%2Fcertificates%2Fpostgres-ca.pem&sslnegotiation=direct',
    });

    expect(config.database.connectionString).toContain('sslmode=verify-full');
  });

  it.each([
    '?sslmode=verify-full&host=%2Fvar%2Frun%2Fpostgresql',
    '?sslmode=verify-full&%68ost=attacker.example.test',
    '?sslmode=verify-full&Host=attacker.example.test',
    '?sslmode=verify-full&port=6543',
    '?sslmode=verify-full&user=attacker&password=attacker',
    '?sslmode=verify-full&sslnegotiation=direct&sslnegotiation=direct',
  ])(
    'rejects PostgreSQL authority overrides or duplicate parameters %s',
    (query) => {
      expect(() =>
        parseRuntimeConfig({
          ...production,
          DATABASE_URL: `postgresql://nexa:password@db.example.test:5432/nexa${query}`,
        }),
      ).toThrow(expect.objectContaining({ key: 'DATABASE_URL' }));
    },
  );

  it.each([
    'postgresql://nexa:password@db.example.test:5432/?sslmode=verify-full',
    'postgresql://nexa:password@db.example.test:5432/nexa?sslmode=verify-full#fragment',
    'postgresql://nexa:password@db.example.test:5432/nexa?sslmode=verify-full&application_name=nexa',
  ])('rejects ambiguous PostgreSQL database URLs %s', (databaseUrl) => {
    expect(() =>
      parseRuntimeConfig({ ...production, DATABASE_URL: databaseUrl }),
    ).toThrow(expect.objectContaining({ key: 'DATABASE_URL' }));
  });

  it('rejects globally disabled TLS verification in production', () => {
    try {
      parseRuntimeConfig({
        ...production,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(safeConfigurationDiagnostic(error)).toEqual({
        code: 'invalid_configuration',
        key: 'NODE_TLS_REJECT_UNAUTHORIZED',
        reason: 'cannot disable certificate verification in production',
      });
    }
  });

  it.each([
    ['NEXA_COORDINATION_ENABLED', 'false'],
    ['NEXA_OBJECT_STORAGE_ENABLED', 'false'],
  ])('requires complete single-host-private providers (%s)', (key, value) => {
    const environment = {
      ...production,
      DATABASE_URL: 'postgresql://nexa:password@postgres:5432/nexa',
      NEXA_DEPLOYMENT_PROFILE: 'single-host-private',
      NEXA_COORDINATION_ENABLED: 'true',
      REDIS_URL: 'redis://:coordination-secret@valkey:6379',
      NEXA_OBJECT_STORAGE_ENABLED: 'true',
      NEXA_OBJECT_STORAGE_CREATE_BUCKET: 'false',
      S3_ENDPOINT: 'http://object-storage:8333',
      S3_ACCESS_KEY: 'access',
      S3_SECRET_KEY: 'secret',
      S3_BUCKET: 'private-objects',
      [key]: value,
    };

    expect(() => parseRuntimeConfig(environment)).toThrow(
      expect.objectContaining({ key }),
    );
  });

  it('does not echo unsupported database query parameter names', () => {
    try {
      parseRuntimeConfig({
        ...production,
        DATABASE_URL:
          'postgresql://nexa:password@db.example.test:5432/nexa?operator-secret=sentinel',
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(JSON.stringify(safeConfigurationDiagnostic(error))).not.toContain(
        'operator-secret',
      );
      expect(JSON.stringify(safeConfigurationDiagnostic(error))).not.toContain(
        'sentinel',
      );
    }
  });

  it.each([
    [
      {
        ...production,
        DATABASE_URL: 'postgresql://nexa:password@postgres:5432/nexa',
      },
      'DATABASE_URL',
    ],
    [{ ...production, NEXA_PUBLIC_URL: undefined }, 'NEXA_PUBLIC_URL'],
    [
      { ...production, NEXA_PUBLIC_URL: 'https://api.example.test' },
      'NEXA_PUBLIC_URL',
    ],
    [
      { ...production, NEXA_PUBLIC_URL: 'https://localhost' },
      'NEXA_PUBLIC_URL',
    ],
    [
      { ...production, NEXA_TRUSTED_PROXY_CIDRS: undefined },
      'NEXA_TRUSTED_PROXY_CIDRS',
    ],
    [
      { ...production, NEXA_TRUSTED_PROXY_CIDRS: '10.20.0.3/24' },
      'NEXA_TRUSTED_PROXY_CIDRS',
    ],
    [
      { ...development, NEXA_DEPLOYMENT_PROFILE: 'single-host-private' },
      'NEXA_DEPLOYMENT_PROFILE',
    ],
    [
      {
        ...production,
        NEXA_DEPLOYMENT_PROFILE: 'single-host-private',
        DATABASE_URL: 'postgresql://nexa:password@postgres.evil:5432/nexa',
      },
      'DATABASE_URL',
    ],
    [
      {
        ...production,
        NEXA_DEPLOYMENT_PROFILE: 'single-host-private',
        NEXA_TRUSTED_PROXY_CIDRS: '10.20.0.0/24',
        DATABASE_URL: 'postgresql://nexa:password@postgres:5432/nexa',
        NEXA_COORDINATION_ENABLED: 'true',
        REDIS_URL: 'redis://:secret@valkey:6379',
        NEXA_OBJECT_STORAGE_ENABLED: 'true',
        S3_ENDPOINT: 'http://object-storage:8333',
        S3_ACCESS_KEY: 'access',
        S3_SECRET_KEY: 'secret',
      },
      'NEXA_TRUSTED_PROXY_CIDRS',
    ],
    [
      {
        ...production,
        NEXA_DEPLOYMENT_PROFILE: 'single-host-private',
        NEXA_TRUSTED_PROXY_CIDRS: '2001:db8::/32',
        DATABASE_URL: 'postgresql://nexa:password@postgres:5432/nexa',
        NEXA_COORDINATION_ENABLED: 'true',
        REDIS_URL: 'redis://:secret@valkey:6379',
        NEXA_OBJECT_STORAGE_ENABLED: 'true',
        S3_ENDPOINT: 'http://object-storage:8333',
        S3_ACCESS_KEY: 'access',
        S3_SECRET_KEY: 'secret',
      },
      'NEXA_TRUSTED_PROXY_CIDRS',
    ],
    [
      {
        ...production,
        NEXA_DEPLOYMENT_PROFILE: 'single-host-private',
        DATABASE_URL: 'postgresql://nexa:password@postgres:5432/nexa',
        NEXA_COORDINATION_ENABLED: 'true',
        REDIS_URL: 'redis://:secret@valkey.evil:6379',
      },
      'REDIS_URL',
    ],
    [
      {
        ...production,
        NEXA_DEPLOYMENT_PROFILE: 'single-host-private',
        DATABASE_URL: 'postgresql://nexa:password@postgres:5432/nexa',
        NEXA_OBJECT_STORAGE_ENABLED: 'true',
        S3_ENDPOINT: 'http://object-storage.evil:8333',
        S3_ACCESS_KEY: 'access',
        S3_SECRET_KEY: 'secret',
        S3_BUCKET: 'private-objects',
      },
      'S3_ENDPOINT',
    ],
  ])('rejects unsafe production topology configuration', (environment, key) => {
    try {
      parseRuntimeConfig(environment);
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(safeConfigurationDiagnostic(error).key).toBe(key);
      expect(JSON.stringify(safeConfigurationDiagnostic(error))).not.toContain(
        'password',
      );
    }
  });

  it.each([
    [{ ...development, DATABASE_URL: undefined }, 'DATABASE_URL'],
    [{ ...development, DATABASE_URL: '' }, 'DATABASE_URL'],
    [{ ...development, DATABASE_URL: 'not a url' }, 'DATABASE_URL'],
    [{ ...development, DATABASE_URL: 'https://db.test' }, 'DATABASE_URL'],
    [
      { ...development, NEXA_WEB_ORIGIN: 'http://localhost:5173/path' },
      'NEXA_WEB_ORIGIN',
    ],
    [
      { ...development, NEXA_SESSION_IDLE_SECONDS: 'nope' },
      'NEXA_SESSION_IDLE_SECONDS',
    ],
    [{ ...development, NEXA_SERVER_PORT: '0' }, 'NEXA_SERVER_PORT'],
    [
      {
        ...development,
        NEXA_SESSION_ABSOLUTE_SECONDS: '300',
        NEXA_SESSION_IDLE_SECONDS: '301',
      },
      'NEXA_SESSION_IDLE_SECONDS',
    ],
    [{ ...production, NEXA_SECURE_COOKIES: 'false' }, 'NEXA_SECURE_COOKIES'],
    [
      { ...production, NEXA_WEB_ORIGIN: 'http://chat.example.test' },
      'NEXA_WEB_ORIGIN',
    ],
    [{ ...production, NEXA_ENABLE_DEV_AUTH: 'true' }, 'NEXA_ENABLE_DEV_AUTH'],
    [
      { ...development, NEXA_DEPRECATED_SETTING: '1' },
      'NEXA_DEPRECATED_SETTING',
    ],
    [{ ...development, NEXA_ARGON2_MEMORY_KIB: '1' }, 'NEXA_ARGON2_MEMORY_KIB'],
    [{ ...development, NEXA_SECURE_COOKIES: 'yes' }, 'NEXA_SECURE_COOKIES'],
    [
      { ...development, NEXA_WS_MAX_SUBSCRIPTIONS: '0' },
      'NEXA_WS_MAX_SUBSCRIPTIONS',
    ],
    [
      { ...development, NEXA_WS_MAX_PAYLOAD_BYTES: '999' },
      'NEXA_WS_MAX_PAYLOAD_BYTES',
    ],
    [{ ...development, NEXA_SERVER_RATE_LIMIT: '9' }, 'NEXA_SERVER_RATE_LIMIT'],
    [{ ...development, NEXA_CONFIG_SCHEMA: '2' }, 'NEXA_CONFIG_SCHEMA'],
    [{ ...development, NEXA_OBJECT_STORAGE_ENABLED: 'true' }, 'S3_ENDPOINT'],
    [{ ...development, NEXA_COORDINATION_ENABLED: 'true' }, 'REDIS_URL'],
    [
      { ...development, NEXA_WEB_PUSH_ENABLED: 'true' },
      'NEXA_WEB_PUSH_SUBJECT',
    ],
    [
      {
        ...production,
        NEXA_COORDINATION_ENABLED: 'true',
        REDIS_URL: 'redis://cache.example.test',
      },
      'REDIS_URL',
    ],
    [
      {
        ...production,
        NEXA_OBJECT_STORAGE_ENABLED: 'true',
        S3_ENDPOINT: 'http://storage.example.test',
        S3_ACCESS_KEY: 'access',
        S3_SECRET_KEY: 'secret',
        S3_BUCKET: 'private-objects',
      },
      'S3_ENDPOINT',
    ],
  ])('rejects invalid input without exposing values', (environment, key) => {
    try {
      parseRuntimeConfig(environment);
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const diagnostic = safeConfigurationDiagnostic(error);
      expect(diagnostic.key).toBe(key);
      expect(JSON.stringify(diagnostic)).not.toContain('password');
    }
  });

  it('accepts documented minimum and maximum numeric boundaries', () => {
    const minimum = parseRuntimeConfig({
      ...development,
      NEXA_SERVER_PORT: '1',
      NEXA_DATABASE_POOL_MAX: '1',
      NEXA_ARGON2_MEMORY_KIB: '19456',
    });
    const maximum = parseRuntimeConfig({
      ...development,
      NEXA_SERVER_PORT: '65535',
      NEXA_DATABASE_POOL_MAX: '50',
      NEXA_ARGON2_MEMORY_KIB: '262144',
    });
    expect(minimum.server.port).toBe(1);
    expect(maximum.server.port).toBe(65_535);
  });

  it('fails before any dependency or listener can be created', () => {
    let composed = false;
    expect(() => {
      const config = parseRuntimeConfig({ NODE_ENV: 'production' });
      composed = Boolean(config);
    }).toThrow(ConfigurationError);
    expect(composed).toBe(false);
  });
});
