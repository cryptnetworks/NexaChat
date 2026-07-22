import { createHash, randomUUID } from 'node:crypto';

export type JobCheckpointValue = string | number | boolean | null;
export type JobCheckpoint = Record<string, JobCheckpointValue>;

export interface RecoverableJob {
  id: string;
  kind: string;
  status:
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancel_requested'
    | 'cancelled';
  attempts: number;
  maxAttempts: number;
  checkpoint: JobCheckpoint;
  createdAt: string;
  availableAt: string;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  completedAt: string | null;
  lastErrorCode: 'handler_failed' | 'timeout' | null;
  version: number;
}

export interface JobRecoveryStore {
  claim(input: {
    workerId: string;
    leaseToken: string;
    kinds: readonly string[];
    now: string;
    leaseExpiresAt: string;
  }): Promise<RecoverableJob | undefined>;
  saveCheckpoint(input: {
    id: string;
    leaseToken: string;
    expectedVersion: number;
    checkpoint: JobCheckpoint;
    leaseExpiresAt: string;
  }): Promise<RecoverableJob | undefined>;
  cancellationState(input: {
    id: string;
    leaseToken: string;
  }): Promise<{ requested: boolean; version: number } | undefined>;
  complete(input: {
    id: string;
    leaseToken: string;
    expectedVersion: number;
    completedAt: string;
  }): Promise<RecoverableJob | undefined>;
  reschedule(input: {
    id: string;
    leaseToken: string;
    expectedVersion: number;
    availableAt: string;
    errorCode: 'handler_failed' | 'timeout';
  }): Promise<RecoverableJob | undefined>;
  fail(input: {
    id: string;
    leaseToken: string;
    expectedVersion: number;
    completedAt: string;
    errorCode: 'handler_failed' | 'timeout';
  }): Promise<RecoverableJob | undefined>;
  cancel(input: {
    id: string;
    leaseToken: string;
    expectedVersion: number;
    completedAt: string;
  }): Promise<RecoverableJob | undefined>;
}

export interface JobExecutionContext {
  job: Readonly<RecoverableJob>;
  signal: AbortSignal;
  saveCheckpoint: (checkpoint: JobCheckpoint) => Promise<void>;
}

export type JobHandler = (context: JobExecutionContext) => Promise<void>;

export interface JobRecoveryMetrics {
  increment(name: string, labels: { kind: string; outcome: string }): void;
}

export class JobRecoveryError extends Error {
  constructor(
    readonly code:
      'invalid_job_worker' | 'job_store_unavailable' | 'invalid_job_checkpoint',
  ) {
    super(code);
  }
}

export interface JobWorkerOptions {
  workerId: string;
  leaseMs: number;
  executionTimeoutMs: number;
  baseRetryMs: number;
  maxRetryMs: number;
}

export type JobRunResult =
  | { claimed: false; outcome: 'idle' }
  | {
      claimed: true;
      jobId: string;
      outcome:
        'succeeded' | 'retry_scheduled' | 'failed' | 'cancelled' | 'lease_lost';
    };

const noopMetrics: JobRecoveryMetrics = { increment() {} };

class LeaseLostError extends Error {}
class ExecutionTimeoutError extends Error {}
class StoreUnavailableError extends Error {}

export class RecoverableJobWorker {
  private readonly kinds: string[];

  constructor(
    private readonly store: JobRecoveryStore,
    private readonly handlers: Readonly<Record<string, JobHandler>>,
    private readonly options: JobWorkerOptions,
    private readonly metrics: JobRecoveryMetrics = noopMetrics,
  ) {
    this.kinds = Object.keys(handlers).sort();
    if (
      !/^[A-Za-z0-9._:-]{1,128}$/.test(options.workerId) ||
      this.kinds.length < 1 ||
      this.kinds.length > 32 ||
      this.kinds.some((kind) => !/^[a-z0-9._:-]{1,64}$/.test(kind)) ||
      !bounded(options.leaseMs, 1_000, 300_000) ||
      !bounded(options.executionTimeoutMs, 100, 300_000) ||
      options.executionTimeoutMs >= options.leaseMs ||
      !bounded(options.baseRetryMs, 100, 3_600_000) ||
      !bounded(options.maxRetryMs, options.baseRetryMs, 86_400_000)
    )
      throw new JobRecoveryError('invalid_job_worker');
  }

  async runOnce(now = new Date()): Promise<JobRunResult> {
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(
      now.getTime() + this.options.leaseMs,
    ).toISOString();
    let job: RecoverableJob | undefined;
    try {
      job = await this.store.claim({
        workerId: this.options.workerId,
        leaseToken,
        kinds: this.kinds,
        now: now.toISOString(),
        leaseExpiresAt,
      });
    } catch {
      this.metrics.increment('background_job_store_failure', {
        kind: 'unknown',
        outcome: 'claim_failed',
      });
      throw new JobRecoveryError('job_store_unavailable');
    }
    if (!job) return { claimed: false, outcome: 'idle' };
    const handler = this.handlers[job.kind];
    if (!handler)
      return this.finishFailure(job, leaseToken, now, 'handler_failed');
    if (job.status === 'cancel_requested') {
      try {
        const cancellation = await this.store.cancellationState({
          id: job.id,
          leaseToken,
        });
        if (!cancellation) return this.result(job, 'lease_lost');
        const cancelled = await this.store.cancel({
          id: job.id,
          leaseToken,
          expectedVersion: cancellation.version,
          completedAt: new Date().toISOString(),
        });
        return cancelled
          ? this.result(job, 'cancelled')
          : this.result(job, 'lease_lost');
      } catch {
        this.metrics.increment('background_job_store_failure', {
          kind: job.kind,
          outcome: 'cancellation_recovery_failed',
        });
        throw new JobRecoveryError('job_store_unavailable');
      }
    }

    let current = job;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new ExecutionTimeoutError());
        controller.abort();
      }, this.options.executionTimeoutMs);
      timeout.unref();
    });
    try {
      const execution = handler({
        job: Object.freeze({ ...job, checkpoint: { ...job.checkpoint } }),
        signal: controller.signal,
        saveCheckpoint: async (checkpoint) => {
          const normalized = normalizeCheckpoint(checkpoint);
          let saved: RecoverableJob | undefined;
          try {
            saved = await this.store.saveCheckpoint({
              id: current.id,
              leaseToken,
              expectedVersion: current.version,
              checkpoint: normalized,
              leaseExpiresAt: new Date(
                Date.now() + this.options.leaseMs,
              ).toISOString(),
            });
          } catch {
            throw new StoreUnavailableError();
          }
          if (!saved) throw new LeaseLostError();
          current = saved;
        },
      });
      await Promise.race([execution, timeoutPromise]);
      let cancellation: { requested: boolean; version: number } | undefined;
      try {
        cancellation = await this.store.cancellationState({
          id: current.id,
          leaseToken,
        });
      } catch {
        throw new StoreUnavailableError();
      }
      if (!cancellation) throw new LeaseLostError();
      if (cancellation.requested) {
        let cancelled: RecoverableJob | undefined;
        try {
          cancelled = await this.store.cancel({
            id: current.id,
            leaseToken,
            expectedVersion: cancellation.version,
            completedAt: new Date().toISOString(),
          });
        } catch {
          throw new StoreUnavailableError();
        }
        if (!cancelled) throw new LeaseLostError();
        return this.result(current, 'cancelled');
      }
      current = { ...current, version: cancellation.version };
      let completed: RecoverableJob | undefined;
      try {
        completed = await this.store.complete({
          id: current.id,
          leaseToken,
          expectedVersion: current.version,
          completedAt: new Date().toISOString(),
        });
      } catch {
        throw new StoreUnavailableError();
      }
      if (!completed) throw new LeaseLostError();
      return this.result(current, 'succeeded');
    } catch (error) {
      if (error instanceof StoreUnavailableError) {
        this.metrics.increment('background_job_store_failure', {
          kind: current.kind,
          outcome: 'execution_state_failed',
        });
        throw new JobRecoveryError('job_store_unavailable');
      }
      if (error instanceof LeaseLostError)
        return this.result(current, 'lease_lost');
      return await this.finishFailure(
        current,
        leaseToken,
        now,
        controller.signal.aborted || error instanceof ExecutionTimeoutError
          ? 'timeout'
          : 'handler_failed',
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async finishFailure(
    job: RecoverableJob,
    leaseToken: string,
    now: Date,
    errorCode: 'handler_failed' | 'timeout',
  ): Promise<JobRunResult> {
    try {
      if (job.attempts >= job.maxAttempts) {
        const failed = await this.store.fail({
          id: job.id,
          leaseToken,
          expectedVersion: job.version,
          completedAt: new Date().toISOString(),
          errorCode,
        });
        if (!failed) return this.result(job, 'lease_lost');
        return this.result(job, 'failed');
      }
      const availableAt = new Date(
        now.getTime() + retryDelay(job.id, job.attempts, this.options),
      ).toISOString();
      const retried = await this.store.reschedule({
        id: job.id,
        leaseToken,
        expectedVersion: job.version,
        availableAt,
        errorCode,
      });
      if (!retried) return this.result(job, 'lease_lost');
      return this.result(job, 'retry_scheduled');
    } catch {
      this.metrics.increment('background_job_store_failure', {
        kind: job.kind,
        outcome: 'settlement_failed',
      });
      throw new JobRecoveryError('job_store_unavailable');
    }
  }

  private result(
    job: RecoverableJob,
    outcome: Exclude<JobRunResult, { claimed: false }>['outcome'],
  ): JobRunResult {
    this.metrics.increment('background_job_run', {
      kind: job.kind,
      outcome,
    });
    return { claimed: true, jobId: job.id, outcome };
  }
}

function bounded(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function normalizeCheckpoint(value: unknown): JobCheckpoint {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new JobRecoveryError('invalid_job_checkpoint');
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (
    entries.length > 32 ||
    entries.some(
      ([key, item]) =>
        !/^[a-z][a-z0-9_]{0,63}$/.test(key) ||
        (!['string', 'number', 'boolean'].includes(typeof item) &&
          item !== null) ||
        (typeof item === 'number' && !Number.isFinite(item)) ||
        (typeof item === 'string' && item.length > 1_024),
    )
  )
    throw new JobRecoveryError('invalid_job_checkpoint');
  const checkpoint = Object.fromEntries(entries);
  if (Buffer.byteLength(JSON.stringify(checkpoint)) > 4_096)
    throw new JobRecoveryError('invalid_job_checkpoint');
  return checkpoint;
}

function retryDelay(
  jobId: string,
  attempts: number,
  options: JobWorkerOptions,
): number {
  const exponential = Math.min(
    options.maxRetryMs,
    options.baseRetryMs * 2 ** Math.min(20, Math.max(0, attempts - 1)),
  );
  const digest = createHash('sha256')
    .update(`${jobId}:${String(attempts)}`)
    .digest();
  const jitter = (digest.readUInt16BE(0) / 65_535) * 0.4 + 0.8;
  return Math.min(
    options.maxRetryMs,
    Math.max(100, Math.floor(exponential * jitter)),
  );
}
