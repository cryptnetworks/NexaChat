import type { StorageReadiness, StorageReadinessResult } from './app.js';
import type { Telemetry } from './telemetry.js';

export type DependencyStatus = 'ok' | 'degraded' | 'disabled';

export interface OptionalDependencyProbe {
  name: 'coordination' | 'objectStorage';
  enabled: boolean;
  check(): Promise<void>;
}

export class OperationalReadiness implements StorageReadiness {
  private started = false;
  private draining = false;
  private readonly dependencyStates = new Map<string, DependencyStatus>();

  constructor(
    private readonly storage: StorageReadiness,
    private readonly optional: readonly OptionalDependencyProbe[] = [],
    private readonly telemetry?: Telemetry,
  ) {}

  markStarted(): void {
    this.started = true;
    this.telemetry?.lifecycle('ready');
  }

  beginDrain(): void {
    this.draining = true;
    this.telemetry?.lifecycle('draining');
  }

  isStarted(): boolean {
    return this.started;
  }

  isDraining(): boolean {
    return this.draining;
  }

  async check(): Promise<StorageReadinessResult> {
    const [storage, optionalStates] = await Promise.all([
      this.checkStorage(),
      Promise.all(
        this.optional.map(async (dependency) => {
          if (!dependency.enabled) return [dependency, 'disabled'] as const;
          try {
            await dependency.check();
            return [dependency, 'ok'] as const;
          } catch {
            return [dependency, 'degraded'] as const;
          }
        }),
      ),
    ]);
    this.reportRequiredStorage(storage.ready ? 'ok' : 'degraded');
    const dependencies: Record<string, DependencyStatus> = {};
    for (const [dependency, status] of optionalStates) {
      dependencies[dependency.name] = status;
      this.reportDependency(dependency.name, status);
    }
    return {
      ...storage,
      ready: storage.ready && this.started && !this.draining,
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
      degraded: Object.values(dependencies).includes('degraded'),
    };
  }

  private async checkStorage(): Promise<StorageReadinessResult> {
    try {
      return await this.storage.check();
    } catch {
      return { ready: false, storage: 'postgresql' };
    }
  }

  private reportDependency(
    dependency: OptionalDependencyProbe['name'],
    status: DependencyStatus,
  ): void {
    this.telemetry?.dependencyHealth(
      dependency === 'objectStorage' ? 'object_storage' : 'coordination',
      status === 'ok' ? 'healthy' : status,
    );
    const previous = this.dependencyStates.get(dependency);
    if (previous === status) return;
    this.dependencyStates.set(dependency, status);
    this.telemetry?.event({
      event: 'dependency.state_changed',
      dependency:
        dependency === 'objectStorage' ? 'object_storage' : 'coordination',
      previous: previous ?? 'unknown',
      status,
    });
  }

  private reportRequiredStorage(status: 'ok' | 'degraded'): void {
    this.telemetry?.dependencyHealth(
      'postgres',
      status === 'ok' ? 'healthy' : 'degraded',
    );
    const previous = this.dependencyStates.get('postgres');
    if (previous === status) return;
    this.dependencyStates.set('postgres', status);
    this.telemetry?.event({
      event: 'dependency.state_changed',
      dependency: 'postgres',
      previous: previous ?? 'unknown',
      status,
    });
  }
}

export interface ShutdownResource {
  name: 'websocket' | 'http' | 'postgres' | 'object_storage' | 'coordination';
  close(): Promise<void> | void;
}

export async function closeWithinDeadline(
  resources: readonly ShutdownResource[],
  timeoutMs: number,
  telemetry: Telemetry,
  log: (record: Record<string, unknown>) => void,
): Promise<void> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + timeoutMs;
  const report = (record: Record<string, unknown>) => {
    try {
      log(record);
    } catch {
      telemetry.recordFailure();
    }
  };
  telemetry.lifecycle('draining');
  report({ event: 'shutdown.started', resourceCount: resources.length });
  try {
    await closeInOrder(resources, deadlineAt, report);
    telemetry.lifecycle('stopped');
    report({
      event: 'shutdown.completed',
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const code =
      error instanceof Error && error.message === 'deadline_exceeded'
        ? 'deadline_exceeded'
        : 'resource_close_failed';
    report({
      event: 'shutdown.failed',
      code,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  } finally {
    telemetry.stopProcessCollection();
  }
}

async function closeInOrder(
  resources: readonly ShutdownResource[],
  deadlineAt: number,
  log: (record: Record<string, unknown>) => void,
): Promise<void> {
  let failure: 'deadline_exceeded' | 'resource_close_failed' | undefined;
  for (const resource of resources) {
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    try {
      const closing = Promise.resolve(resource.close());
      await within(closing, remainingMs);
      log({ event: 'shutdown.resource_closed', resource: resource.name });
    } catch (error) {
      const code =
        error instanceof Error && error.message === 'deadline_exceeded'
          ? 'deadline_exceeded'
          : 'resource_close_failed';
      failure ??= code;
      log({ event: 'shutdown.resource_failed', resource: resource.name, code });
    }
  }
  if (failure) throw new Error(failure);
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('deadline_exceeded'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
