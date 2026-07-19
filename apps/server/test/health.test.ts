import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageReadiness } from '../src/app.js';
import {
  closeWithinDeadline,
  OperationalReadiness,
  type ShutdownResource,
} from '../src/health.js';
import { Telemetry } from '../src/telemetry.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('operational readiness', () => {
  it('stays unready during startup and exposes required storage readiness once started', async () => {
    const storage = requiredStorage({ ready: true, schemaVersion: 6 });
    const readiness = new OperationalReadiness(storage);

    expect(readiness.isStarted()).toBe(false);
    await expect(readiness.check()).resolves.toEqual({
      ready: false,
      storage: 'postgresql',
      schemaVersion: 6,
      degraded: false,
    });

    readiness.markStarted();

    expect(readiness.isStarted()).toBe(true);
    await expect(readiness.check()).resolves.toEqual({
      ready: true,
      storage: 'postgresql',
      schemaVersion: 6,
      degraded: false,
    });
  });

  it('never reports ready when required PostgreSQL readiness fails', async () => {
    const storage = requiredStorage({ ready: false });
    const readiness = new OperationalReadiness(storage);
    readiness.markStarted();

    await expect(readiness.check()).resolves.toEqual({
      ready: false,
      storage: 'postgresql',
      degraded: false,
    });
  });

  it('reports optional degradation without failing readiness and observes recovery', async () => {
    const events: Record<string, unknown>[] = [];
    const telemetry = new Telemetry();
    telemetry.setLogSink((record) => events.push(record));
    const coordination = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('private dependency detail'))
      .mockResolvedValue(undefined);
    const disabledObjectStorage = vi.fn<() => Promise<void>>();
    const readiness = new OperationalReadiness(
      requiredStorage({ ready: true }),
      [
        { name: 'coordination', enabled: true, check: coordination },
        {
          name: 'objectStorage',
          enabled: false,
          check: disabledObjectStorage,
        },
      ],
      telemetry,
    );
    readiness.markStarted();

    await expect(readiness.check()).resolves.toEqual({
      ready: true,
      storage: 'postgresql',
      dependencies: {
        coordination: 'degraded',
        objectStorage: 'disabled',
      },
      degraded: true,
    });
    await expect(readiness.check()).resolves.toEqual({
      ready: true,
      storage: 'postgresql',
      dependencies: {
        coordination: 'ok',
        objectStorage: 'disabled',
      },
      degraded: false,
    });
    expect(disabledObjectStorage).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        event: 'dependency.state_changed',
        dependency: 'postgres',
        previous: 'unknown',
        status: 'ok',
      },
      {
        event: 'dependency.state_changed',
        dependency: 'coordination',
        previous: 'unknown',
        status: 'degraded',
      },
      {
        event: 'dependency.state_changed',
        dependency: 'object_storage',
        previous: 'unknown',
        status: 'disabled',
      },
      {
        event: 'dependency.state_changed',
        dependency: 'coordination',
        previous: 'degraded',
        status: 'ok',
      },
    ]);
    const metrics = telemetry.metrics.render();
    expect(metrics).toContain(
      'nexa_dependency_health{dependency="coordination",status="healthy"} 1',
    );
    expect(metrics).toContain(
      'nexa_dependency_health{dependency="coordination",status="degraded"} 0',
    );
    expect(metrics).toContain(
      'nexa_dependency_health{dependency="object_storage",status="disabled"} 1',
    );
    expect(JSON.stringify({ events, metrics })).not.toContain(
      'private dependency detail',
    );
  });

  it('becomes unready while draining and publishes the lifecycle transition', async () => {
    const telemetry = new Telemetry();
    const lifecycle = vi.spyOn(telemetry, 'lifecycle');
    const readiness = new OperationalReadiness(
      requiredStorage({ ready: true }),
      [],
      telemetry,
    );
    readiness.markStarted();

    readiness.beginDrain();

    expect(readiness.isDraining()).toBe(true);
    expect(lifecycle.mock.calls.map(([state]) => state)).toEqual([
      'ready',
      'draining',
    ]);
    await expect(readiness.check()).resolves.toMatchObject({ ready: false });
  });

  it('runs required and optional dependency probes in parallel', async () => {
    const storage = deferred<{
      ready: boolean;
      storage: 'postgresql';
    }>();
    const coordination = deferred();
    const objectStorage = deferred();
    const storageCheck = vi.fn(() => storage.promise);
    const coordinationCheck = vi.fn(() => coordination.promise);
    const objectStorageCheck = vi.fn(() => objectStorage.promise);
    const readiness = new OperationalReadiness({ check: storageCheck }, [
      { name: 'coordination', enabled: true, check: coordinationCheck },
      { name: 'objectStorage', enabled: true, check: objectStorageCheck },
    ]);
    readiness.markStarted();

    const checking = readiness.check();

    expect(storageCheck).toHaveBeenCalledOnce();
    expect(coordinationCheck).toHaveBeenCalledOnce();
    expect(objectStorageCheck).toHaveBeenCalledOnce();
    storage.resolve({ ready: true, storage: 'postgresql' });
    coordination.resolve();
    objectStorage.resolve();
    await expect(checking).resolves.toEqual({
      ready: true,
      storage: 'postgresql',
      dependencies: { coordination: 'ok', objectStorage: 'ok' },
      degraded: false,
    });
  });
});

describe('bounded shutdown', () => {
  it('closes resources sequentially in the supplied safe order', async () => {
    const order: string[] = [];
    const first = deferred();
    const telemetry = new Telemetry();
    const lifecycle = vi.spyOn(telemetry, 'lifecycle');
    const stopCollection = vi.spyOn(telemetry, 'stopProcessCollection');
    const log = vi.fn<(record: Record<string, unknown>) => void>();
    const resources: ShutdownResource[] = [
      {
        name: 'websocket',
        close: async () => {
          order.push('websocket:start');
          await first.promise;
          order.push('websocket:end');
        },
      },
      {
        name: 'http',
        close: () => {
          order.push('http');
        },
      },
      {
        name: 'postgres',
        close: () => {
          order.push('postgres');
        },
      },
    ];

    const closing = closeWithinDeadline(resources, 1_000, telemetry, log);
    await vi.waitFor(() => {
      expect(order).toEqual(['websocket:start']);
    });
    first.resolve();
    await closing;

    expect(order).toEqual([
      'websocket:start',
      'websocket:end',
      'http',
      'postgres',
    ]);
    expect(lifecycle.mock.calls.map(([state]) => state)).toEqual([
      'draining',
      'stopped',
    ]);
    expect(log.mock.calls.map(([record]) => record.event)).toEqual([
      'shutdown.started',
      'shutdown.resource_closed',
      'shutdown.resource_closed',
      'shutdown.resource_closed',
      'shutdown.completed',
    ]);
    expect(stopCollection).toHaveBeenCalledOnce();
  });

  it('redacts a resource failure, continues safe cleanup, and always stops collection', async () => {
    const failure = new Error('private resource failure');
    const later = vi.fn();
    const telemetry = new Telemetry();
    const lifecycle = vi.spyOn(telemetry, 'lifecycle');
    const stopCollection = vi.spyOn(telemetry, 'stopProcessCollection');
    const log = vi.fn<(record: Record<string, unknown>) => void>();

    await expect(
      closeWithinDeadline(
        [
          { name: 'websocket', close: () => undefined },
          {
            name: 'http',
            close: () => Promise.reject(failure),
          },
          { name: 'postgres', close: later },
        ],
        1_000,
        telemetry,
        log,
      ),
    ).rejects.toThrow('resource_close_failed');

    expect(later).toHaveBeenCalledOnce();
    expect(lifecycle).toHaveBeenCalledWith('draining');
    expect(lifecycle).not.toHaveBeenCalledWith('stopped');
    expect(log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: 'shutdown.failed',
        code: 'resource_close_failed',
      }),
    );
    expect(log).toHaveBeenCalledWith({
      event: 'shutdown.resource_failed',
      resource: 'http',
      code: 'resource_close_failed',
    });
    expect(log).toHaveBeenCalledWith({
      event: 'shutdown.resource_closed',
      resource: 'postgres',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      'private resource failure',
    );
    expect(stopCollection).toHaveBeenCalledOnce();
  });

  it('rejects on the configured deadline and always stops collection', async () => {
    vi.useFakeTimers();
    const telemetry = new Telemetry();
    const lifecycle = vi.spyOn(telemetry, 'lifecycle');
    const stopCollection = vi.spyOn(telemetry, 'stopProcessCollection');
    const log = vi.fn<(record: Record<string, unknown>) => void>();
    const never = new Promise<void>(() => {});

    const closing = closeWithinDeadline(
      [{ name: 'websocket', close: () => never }],
      25,
      telemetry,
      log,
    );
    const rejected = expect(closing).rejects.toThrow('deadline_exceeded');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;

    expect(lifecycle).toHaveBeenCalledWith('draining');
    expect(lifecycle).not.toHaveBeenCalledWith('stopped');
    expect(log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: 'shutdown.failed',
        code: 'deadline_exceeded',
      }),
    );
    expect(stopCollection).toHaveBeenCalledOnce();
  });

  it('safely completes when no resources are configured', async () => {
    const telemetry = new Telemetry();
    const stopCollection = vi.spyOn(telemetry, 'stopProcessCollection');
    const log = vi.fn<(record: Record<string, unknown>) => void>();

    await expect(
      closeWithinDeadline([], 1_000, telemetry, log),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith({
      event: 'shutdown.started',
      resourceCount: 0,
    });
    expect(log).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: 'shutdown.completed' }),
    );
    expect(stopCollection).toHaveBeenCalledOnce();
  });

  it('isolates a throwing log sink and still closes every resource', async () => {
    const closed: string[] = [];
    const telemetry = new Telemetry();
    const recordFailure = vi.spyOn(telemetry, 'recordFailure');
    const stopCollection = vi.spyOn(telemetry, 'stopProcessCollection');
    const log = vi.fn(() => {
      throw new Error('private log sink failure');
    });

    await expect(
      closeWithinDeadline(
        [
          {
            name: 'websocket',
            close: () => {
              closed.push('websocket');
            },
          },
          {
            name: 'http',
            close: () => {
              closed.push('http');
            },
          },
          {
            name: 'postgres',
            close: () => {
              closed.push('postgres');
            },
          },
        ],
        1_000,
        telemetry,
        log,
      ),
    ).resolves.toBeUndefined();

    expect(closed).toEqual(['websocket', 'http', 'postgres']);
    expect(log).toHaveBeenCalledTimes(5);
    expect(recordFailure).toHaveBeenCalledTimes(5);
    expect(stopCollection).toHaveBeenCalledOnce();
  });
});

function requiredStorage(result: {
  ready: boolean;
  schemaVersion?: number;
}): StorageReadiness {
  return {
    check: () =>
      Promise.resolve({
        ...result,
        storage: 'postgresql' as const,
      }),
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
