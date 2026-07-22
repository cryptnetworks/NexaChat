import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CoordinationError,
  ValkeyCoordination,
  type CoordinationConfig,
  type CoordinationObserver,
} from '../src/index.js';

const liveEndpoint = process.env.COORDINATION_TEST_URL;
const integration = liveEndpoint ? describe : describe.skip;

afterEach(() => {
  vi.useRealTimers();
});

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

  it('atomically increments an expiring fixed-window counter', async () => {
    const client = fake();
    client.eval.mockResolvedValueOnce([1, 10]).mockResolvedValueOnce([2, 9]);
    const store = new ValkeyCoordination(config, client);

    await expect(store.increment('limit:hashed-client', 10)).resolves.toEqual({
      count: 1,
      ttlSeconds: 10,
    });
    await expect(store.increment('limit:hashed-client', 10)).resolves.toEqual({
      count: 2,
      ttlSeconds: 9,
    });
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), {
      keys: ['nexa-test:limit:hashed-client'],
      arguments: ['10'],
    });
  });

  it('rejects a malformed counter response as provider unavailability', async () => {
    const client = fake();
    client.eval.mockResolvedValue(['private-malformed-value']);
    const store = new ValkeyCoordination(config, client);
    await expect(store.increment('limit:safe', 10)).rejects.toMatchObject({
      code: 'coordination_unavailable',
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

describe('Valkey coordination observer', () => {
  it('cannot change successful authoritative operations when the observer throws', async () => {
    const client = fake();
    client.set.mockResolvedValue('OK');
    const observer = {
      event: vi.fn<CoordinationObserver['event']>(() => {
        throw new Error('telemetry unavailable');
      }),
    };
    const store = new ValkeyCoordination(config, client, observer);

    await expect(store.verify()).resolves.toBeUndefined();
    await expect(
      store.setIfAbsent('private:key', 'private-value', 10),
    ).resolves.toBe(true);
    await expect(store.get('private:key')).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();

    expect(observer.event).toHaveBeenCalled();
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it('reports a failed verification and observes recovery on a repeated verify', async () => {
    const providerMessage = 'private provider connection detail';
    const client = fake();
    client.connect
      .mockRejectedValueOnce(new Error(providerMessage))
      .mockResolvedValueOnce(undefined);
    const observer = { event: vi.fn<CoordinationObserver['event']>() };
    const privateConfig = {
      ...config,
      url: 'redis://private-user:private-password@127.0.0.1:1',
    };
    const store = new ValkeyCoordination(privateConfig, client, observer);

    await expect(store.verify()).rejects.toMatchObject({
      code: 'coordination_unavailable',
    });
    await expect(store.verify()).resolves.toBeUndefined();

    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.ping).toHaveBeenCalledOnce();
    expect(
      observer.event.mock.calls.map(([operation, outcome]) => [
        operation,
        outcome,
      ]),
    ).toEqual([
      ['connect', 'failure'],
      ['connect', 'success'],
      ['retry', 'success'],
    ]);
    for (const call of observer.event.mock.calls) {
      expect(call[2]).toBeTypeOf('number');
      expect(call[2]).toBeGreaterThanOrEqual(0);
    }
    const payload = JSON.stringify(observer.event.mock.calls);
    for (const secret of [
      providerMessage,
      privateConfig.url,
      'private-user',
      'private-password',
    ])
      expect(payload).not.toContain(secret);
  });

  it('emits safe success and failure outcomes without keys, values, or provider messages', async () => {
    const key = 'private:key';
    const value = 'private-value';
    const providerMessage = 'private provider operation detail';
    const client = fake();
    client.get.mockRejectedValueOnce(new Error(providerMessage));
    const observer = { event: vi.fn<CoordinationObserver['event']>() };
    const store = new ValkeyCoordination(config, client, observer);

    await expect(store.set(key, value, 10)).resolves.toBeUndefined();
    await expect(store.get(key)).rejects.toMatchObject({
      code: 'coordination_unavailable',
    });

    expect(
      observer.event.mock.calls.map(([operation, outcome]) => [
        operation,
        outcome,
      ]),
    ).toEqual([
      ['operation', 'success'],
      ['operation', 'failure'],
    ]);
    for (const call of observer.event.mock.calls) {
      expect(call[2]).toBeTypeOf('number');
      expect(call[2]).toBeGreaterThanOrEqual(0);
    }
    const payload = JSON.stringify(observer.event.mock.calls);
    for (const secret of [key, value, providerMessage, config.url])
      expect(payload).not.toContain(secret);
  });

  it('classifies a bounded operation timeout without exposing operation data', async () => {
    vi.useFakeTimers();
    const client = fake();
    client.get.mockReturnValue(new Promise<string | null>(() => {}));
    const observer = { event: vi.fn<CoordinationObserver['event']>() };
    const store = new ValkeyCoordination(config, client, observer);

    const operation = store.get('private:key');
    const rejection = expect(operation).rejects.toMatchObject({
      code: 'coordination_unavailable',
    });
    await vi.advanceTimersByTimeAsync(config.operationTimeoutMs);
    await rejection;

    expect(observer.event).toHaveBeenCalledWith(
      'timeout',
      'failure',
      expect.any(Number),
    );
    expect(JSON.stringify(observer.event.mock.calls)).not.toContain(
      'private:key',
    );
  });

  it('reports a timed-out graceful close and forced-close degradation', async () => {
    vi.useFakeTimers();
    const client = fake();
    client.quit.mockReturnValue(new Promise<unknown>(() => {}));
    const observer = { event: vi.fn<CoordinationObserver['event']>() };
    const store = new ValkeyCoordination(config, client, observer);

    const closing = store.close();
    await vi.advanceTimersByTimeAsync(config.operationTimeoutMs);
    await expect(closing).resolves.toBeUndefined();

    expect(client.destroy).toHaveBeenCalledOnce();
    expect(
      observer.event.mock.calls.map(([operation, outcome]) => [
        operation,
        outcome,
      ]),
    ).toEqual([
      ['timeout', 'failure'],
      ['close', 'degraded'],
    ]);
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
    const counterKey = `integration:counter:${String(Date.now())}`;
    const increments = await Promise.all(
      Array.from({ length: 25 }, () => store.increment(counterKey, 2)),
    );
    expect(increments.map(({ count }) => count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    expect(increments.every(({ ttlSeconds }) => ttlSeconds > 0)).toBe(true);
    expect(await store.delete(counterKey)).toBe(true);
    await store.close();
  });
});

function fake() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue('PONG'),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn().mockResolvedValue([1, 10]),
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
