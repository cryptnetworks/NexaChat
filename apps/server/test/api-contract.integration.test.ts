import { describe, expect, it } from 'vitest';
import { errorResponseSchema } from '@nexa/api-contracts';
import { InMemoryCommunityService } from '@nexa/domain';
import { buildApp } from '../src/app.js';

describe('standard API errors and request metadata', () => {
  it('returns one versioned envelope and request metadata for validation, privacy, and missing routes', async () => {
    const app = buildApp();
    for (const request of [
      app.inject({
        method: 'POST',
        url: '/v1/dev/accounts',
        payload: { displayName: '' },
      }),
      app.inject({ method: 'GET', url: '/v1/not-a-route' }),
    ]) {
      const response = await request;
      const error = errorResponseSchema.parse(response.json());
      expect(error.version).toBe(1);
      expect(error.correlationId).toBe(response.headers['x-request-id']);
      expect(response.headers['x-api-version']).toBe('1');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(error.retryable).toBe(false);
    }
    await app.close();
  });

  it('bounds payloads and request rates with deterministic retry metadata', async () => {
    const app = buildApp(
      new InMemoryCommunityService(),
      undefined,
      undefined,
      undefined,
      {
        host: '127.0.0.1',
        port: 3000,
        bodyLimitBytes: 1_024,
        requestTimeoutMs: 1_000,
        shutdownTimeoutMs: 1_000,
        rateLimit: 10,
        rateWindowMs: 60_000,
      },
    );
    const oversized = await app.inject({
      method: 'POST',
      url: '/v1/dev/accounts',
      payload: { displayName: 'x'.repeat(2_000) },
    });
    expect(oversized.statusCode).toBe(413);
    expect(errorResponseSchema.parse(oversized.json())).toMatchObject({
      error: 'payload_too_large',
      retryable: false,
    });
    for (let index = 0; index < 9; index += 1)
      await app.inject({ method: 'GET', url: '/health/live' });
    const limited = await app.inject({ method: 'GET', url: '/health/live' });
    expect(limited.statusCode).toBe(429);
    expect(errorResponseSchema.parse(limited.json())).toMatchObject({
      error: 'rate_limited',
      retryable: true,
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });

  it('keeps dependency readiness failure bounded and observable through metadata', async () => {
    const app = buildApp(undefined, {
      check: () =>
        Promise.resolve({ ready: false, storage: 'postgresql' as const }),
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.headers['x-api-version']).toBe('1');
    expect(response.headers['retry-after']).toBe('5');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      status: 'unavailable',
      storage: 'postgresql',
    });
    await app.close();
  });
});
