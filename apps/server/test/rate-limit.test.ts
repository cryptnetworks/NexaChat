import { describe, expect, it, vi } from 'vitest';
import type { EphemeralCoordination } from '@nexa/coordination';
import { InMemoryCommunityService } from '@nexa/domain';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import {
  DistributedRequestRateLimiter,
  endpointFor,
} from '../src/rate-limit.js';

describe('distributed request rate limiting', () => {
  it('classifies only bounded endpoint groups', () => {
    expect(endpointFor('POST', '/v1/auth/login')).toBe('authentication');
    expect(endpointFor('POST', '/v1/communities/:id/invitations')).toBe(
      'invitation',
    );
    expect(endpointFor('GET', '/v1/private/resource/123')).toBe('read');
    expect(endpointFor('PATCH', '/v1/private/resource/123')).toBe('write');
    expect(endpointFor('OPTIONS', '/unknown')).toBe('other');
  });

  it('uses shared atomic counters without exposing address or account identifiers', async () => {
    const { coordination, increment } = fakeCoordination();
    const limiter = new DistributedRequestRateLimiter(
      { addressLimit: 2, accountLimit: 1, windowMs: 10_000 },
      coordination,
    );

    const first = await limiter.consumeAddress({
      method: 'GET',
      route: '/v1/communities',
      address: '203.0.113.77',
    });
    const second = await limiter.consumeAccount({
      method: 'POST',
      route: '/v1/communities/:id/spaces',
      accountId: 'private-account-id',
      trust: 'authenticated',
    });

    expect(first).toMatchObject({ allowed: true, backend: 'shared' });
    expect(second).toMatchObject({ allowed: true, backend: 'shared' });
    const keys = increment.mock.calls.map(([key]) => key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toContain('rate:address:read:public:');
    expect(keys[1]).toContain('rate:account:write:authenticated:');
    expect(JSON.stringify(keys)).not.toContain('203.0.113.77');
    expect(JSON.stringify(keys)).not.toContain('private-account-id');
  });

  it('is deterministic at the boundary and returns exact retry metadata', async () => {
    const limiter = new DistributedRequestRateLimiter(
      { addressLimit: 1, accountLimit: 1, windowMs: 12_000 },
      fakeCoordination().coordination,
    );
    const input = {
      method: 'GET',
      route: '/v1/communities',
      address: '198.51.100.4',
    };
    await expect(limiter.consumeAddress(input)).resolves.toMatchObject({
      allowed: true,
      limit: 1,
      remaining: 0,
      retryAfterSeconds: 12,
    });
    await expect(limiter.consumeAddress(input)).resolves.toMatchObject({
      allowed: false,
      reason: 'rate_limited',
      limit: 1,
      remaining: 0,
      retryAfterSeconds: 12,
    });
  });

  it('fails closed for sensitive endpoints and degrades to bounded local state for ordinary traffic', async () => {
    const { coordination, increment } = fakeCoordination();
    increment.mockRejectedValue(new Error('private provider failure'));
    const observer = { decision: vi.fn() };
    const limiter = new DistributedRequestRateLimiter(
      { addressLimit: 2, accountLimit: 2, windowMs: 10_000 },
      coordination,
      observer,
    );

    await expect(
      limiter.consumeAddress({
        method: 'POST',
        route: '/v1/auth/login',
        address: '192.0.2.10',
      }),
    ).resolves.toMatchObject({
      allowed: false,
      degraded: true,
      reason: 'dependency_unavailable',
      retryAfterSeconds: 5,
    });
    await expect(
      limiter.consumeAddress({
        method: 'GET',
        route: '/v1/communities',
        address: '192.0.2.10',
      }),
    ).resolves.toMatchObject({
      allowed: true,
      backend: 'local',
      degraded: true,
    });
    expect(JSON.stringify(observer.decision.mock.calls)).not.toContain(
      '192.0.2.10',
    );
  });

  it('recovers to the shared backend without restarting', async () => {
    const { coordination, increment } = fakeCoordination();
    increment
      .mockRejectedValueOnce(new Error('outage'))
      .mockResolvedValueOnce({ count: 1, ttlSeconds: 10 });
    const limiter = new DistributedRequestRateLimiter(
      { addressLimit: 2, accountLimit: 2, windowMs: 10_000 },
      coordination,
    );
    const input = {
      method: 'GET',
      route: '/v1/communities',
      address: '192.0.2.44',
    };
    await expect(limiter.consumeAddress(input)).resolves.toMatchObject({
      backend: 'local',
      degraded: true,
    });
    await expect(limiter.consumeAddress(input)).resolves.toMatchObject({
      backend: 'shared',
      degraded: false,
    });
  });
});

describe('HTTP distributed request admission', () => {
  it('shares address counters across application replicas', async () => {
    const { coordination } = fakeCoordination();
    const first = application(1, coordination);
    const second = application(1, coordination);

    expect(
      (await first.inject({ method: 'GET', url: '/v1/not-a-route' }))
        .statusCode,
    ).toBe(404);
    const limited = await second.inject({
      method: 'GET',
      url: '/v1/not-a-route',
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      error: 'rate_limited',
      retryable: true,
    });
    expect(limited.headers['retry-after']).toBe('10');
    expect(limited.headers['ratelimit-limit']).toBe('1');
    expect(limited.headers['ratelimit-remaining']).toBe('0');

    await Promise.all([first.close(), second.close()]);
  });

  it('shares authenticated-account scope independently of client addresses', async () => {
    const service = new InMemoryCommunityService();
    const owner = await service.createAccount('Owner');
    const { coordination } = fakeCoordination();
    const first = application(2, coordination, service);
    const second = application(2, coordination, service);

    const request = (
      app: ReturnType<typeof buildApp>,
      address: string,
      name: string,
    ) =>
      app.inject({
        method: 'POST',
        url: '/v1/communities',
        headers: { 'x-forwarded-for': address },
        payload: { ownerId: owner.id, name },
      });
    expect((await request(first, '192.0.2.1', 'One')).statusCode).toBe(201);
    expect((await request(second, '192.0.2.2', 'Two')).statusCode).toBe(201);
    const limited = await request(first, '192.0.2.3', 'Three');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['ratelimit-limit']).toBe('2');

    await Promise.all([first.close(), second.close()]);
  });

  it('fails sensitive traffic closed while ordinary traffic degrades and recovers', async () => {
    const { coordination, increment } = fakeCoordination();
    increment.mockRejectedValue(new Error('private provider outage'));
    const app = application(10, coordination);

    const sensitive = await app.inject({
      method: 'POST',
      url: '/v1/invitations/preview',
      payload: {
        actorId: '00000000-0000-4000-8000-000000000001',
        token: 'A'.repeat(43),
      },
    });
    expect(sensitive.statusCode).toBe(503);
    expect(sensitive.headers['retry-after']).toBe('5');
    expect(sensitive.json()).toMatchObject({
      error: 'dependency_unavailable',
      retryable: true,
    });

    const degraded = await app.inject({
      method: 'GET',
      url: '/v1/not-a-route',
    });
    expect(degraded.statusCode).toBe(404);
    expect(degraded.headers['ratelimit-limit']).toBe('10');

    increment.mockImplementation((_key: string, ttlSeconds: number) =>
      Promise.resolve({ count: 1, ttlSeconds }),
    );
    const recovered = await app.inject({
      method: 'GET',
      url: '/v1/not-a-route',
    });
    expect(recovered.statusCode).toBe(404);
    expect(recovered.headers['ratelimit-remaining']).toBe('9');
    await app.close();
  });
});

function fakeCoordination() {
  const counts = new Map<string, number>();
  const increment = vi.fn((key: string, ttlSeconds: number) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return Promise.resolve({ count, ttlSeconds });
  });
  const coordination: EphemeralCoordination = {
    verify: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    setIfAbsent: vi.fn().mockResolvedValue(true),
    increment,
    delete: vi.fn().mockResolvedValue(false),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { coordination, increment };
}

function application(
  limit: number,
  coordination: EphemeralCoordination,
  service = new InMemoryCommunityService(),
) {
  return buildApp(
    service,
    undefined,
    undefined,
    undefined,
    {
      host: '127.0.0.1',
      port: 3000,
      bodyLimitBytes: 16_384,
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
      rateLimit: limit,
      rateWindowMs: 10_000,
      logLevel: 'info',
      trustedProxyCidrs: ['127.0.0.1/32'],
    } satisfies RuntimeConfig['server'],
    undefined,
    coordination,
  );
}
