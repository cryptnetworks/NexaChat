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
  DATABASE_URL: 'postgresql://nexa:password@db.example.test:5432/nexa',
  NEXA_WEB_ORIGIN: 'https://chat.example.test',
  NEXA_SECURE_COOKIES: 'true',
};

describe('runtime configuration', () => {
  it('parses valid development and production settings', () => {
    expect(parseRuntimeConfig(development).mode).toBe('development');
    const config = parseRuntimeConfig(production);
    expect(config.authentication.secureCookies).toBe(true);
    expect(config.database.maxConnections).toBe(10);
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
