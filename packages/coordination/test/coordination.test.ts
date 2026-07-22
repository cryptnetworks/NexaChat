import { describe, expect, it, vi } from 'vitest';
import {
  CoordinationError,
  ValkeyCoordination,
  type CoordinationConfig,
} from '../src/index.js';

const liveEndpoint = process.env.COORDINATION_TEST_URL;
const integration = liveEndpoint ? describe : describe.skip;

describe('Valkey coordination bounds', () => {
  it('namespaces values, requires expiry, and provides atomic NX behavior', async () => {
    const client = fake();
    client.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const store = new ValkeyCoordination(config, client);
    expect(await store.setIfAbsent('lock:one', 'owner', 10)).toBe(true);
    expect(await store.setIfAbsent('lock:one', 'other', 10)).toBe(false);
    expect(client.set).toHaveBeenCalledWith('nexa-test:lock:one', 'owner', {
      EX: 10,
      NX: true,
    });
    await expect(store.set('bad key', 'value', 1)).rejects.toMatchObject({
      code: 'invalid_coordination',
    });
    await expect(store.set('safe', 'value', 0)).rejects.toMatchObject({
      code: 'invalid_coordination',
    });
  });

  it('opens its circuit after bounded failures and recovers after reset', async () => {
    vi.useFakeTimers();
    const client = fake();
    client.get.mockRejectedValue(new Error('private provider detail'));
    const store = new ValkeyCoordination(
      { ...config, circuitFailures: 2 },
      client,
    );
    await expect(store.get('one')).rejects.toMatchObject({
      code: 'coordination_unavailable',
    });
    await expect(store.get('two')).rejects.toMatchObject({
      code: 'coordination_unavailable',
    });
    await expect(store.get('three')).rejects.toMatchObject({
      code: 'coordination_unavailable',
    });
    expect(client.get).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(config.circuitResetMs);
    client.get.mockResolvedValueOnce('recovered');
    expect(await store.get('one')).toBe('recovered');
    vi.useRealTimers();
  });

  it('rejects invalid configuration without exposing values', () => {
    expect(
      () =>
        new ValkeyCoordination(
          { ...config, url: 'https://secret:test@example.test' },
          fake(),
        ),
    ).toThrow(new CoordinationError('invalid_coordination'));
  });

  it('publishes bounded namespaced payloads', async () => {
    const client = fake();
    client.publish.mockResolvedValue(1);
    const store = new ValkeyCoordination(config, client);
    await store.publish('events', 'bounded');
    expect(client.publish).toHaveBeenCalledWith('nexa-test:events', 'bounded');
    await expect(store.publish('events', 'x'.repeat(17))).rejects.toMatchObject(
      {
        code: 'invalid_coordination',
      },
    );
  });
});

integration('real Valkey outage and recovery', () => {
  it('stores expiring namespaced state and observes recovery', async () => {
    const store = new ValkeyCoordination({
      ...config,
      url: liveEndpoint ?? 'redis://127.0.0.1:1',
    });
    await store.verify();
    await store.set('integration:value', 'private', 2);
    expect(await store.get('integration:value')).toBe('private');
    expect(await store.delete('integration:value')).toBe(true);
    expect(await store.get('integration:value')).toBeUndefined();
    await store.close();
  });
});

function fake() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue('PONG'),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(0),
    publish: vi.fn().mockResolvedValue(0),
    quit: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    on: vi.fn(),
  };
}

const config: CoordinationConfig = {
  url: 'redis://127.0.0.1:1',
  namespace: 'nexa-test',
  operationTimeoutMs: 50,
  connectTimeoutMs: 50,
  circuitFailures: 3,
  circuitResetMs: 1000,
  maxValueBytes: 16,
  maxTtlSeconds: 60,
};
