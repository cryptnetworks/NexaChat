import { describe, expect, it, vi } from 'vitest';
import {
  JobRecoveryError,
  RecoverableJobWorker,
  type JobCheckpoint,
  type JobExecutionContext,
  type JobRecoveryStore,
  type RecoverableJob,
} from '../src/job-recovery.js';

class MemoryJobStore implements JobRecoveryStore {
  readonly jobs = new Map<string, RecoverableJob>();
  claimFailure: Error | undefined;

  add(job: RecoverableJob): void {
    this.jobs.set(job.id, structuredClone(job));
  }

  value(id: string): RecoverableJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error('missing test job');
    return structuredClone(job);
  }

  requestCancellation(id: string): void {
    const job = this.value(id);
    this.jobs.set(id, {
      ...job,
      status: 'cancel_requested',
      version: job.version + 1,
    });
  }

  claim: JobRecoveryStore['claim'] = (input) => {
    if (this.claimFailure) return Promise.reject(this.claimFailure);
    const candidate = [...this.jobs.values()]
      .filter(
        (job) =>
          input.kinds.includes(job.kind) &&
          ((job.status === 'queued' && job.availableAt <= input.now) ||
            (job.status === 'running' &&
              job.leaseExpiresAt !== null &&
              job.leaseExpiresAt <= input.now) ||
            (job.status === 'cancel_requested' &&
              (job.leaseExpiresAt === null ||
                job.leaseExpiresAt <= input.now))),
      )
      .sort(
        (left, right) =>
          left.availableAt.localeCompare(right.availableAt) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )[0];
    if (!candidate) return Promise.resolve(undefined);
    const claimed: RecoverableJob = {
      ...candidate,
      status:
        candidate.status === 'cancel_requested'
          ? 'cancel_requested'
          : 'running',
      attempts:
        candidate.status === 'cancel_requested'
          ? candidate.attempts
          : candidate.attempts + 1,
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.leaseExpiresAt,
      version: candidate.version + 1,
    };
    this.jobs.set(claimed.id, claimed);
    return Promise.resolve(structuredClone(claimed));
  };

  saveCheckpoint: JobRecoveryStore['saveCheckpoint'] = (input) =>
    Promise.resolve(
      this.updateRunning(input, (job) => ({
        ...job,
        checkpoint: structuredClone(input.checkpoint),
        leaseExpiresAt: input.leaseExpiresAt,
      })),
    );

  cancellationState: JobRecoveryStore['cancellationState'] = (input) => {
    const job = this.jobs.get(input.id);
    if (!job || job.leaseToken !== input.leaseToken)
      return Promise.resolve(undefined);
    return Promise.resolve({
      requested: job.status === 'cancel_requested',
      version: job.version,
    });
  };

  complete: JobRecoveryStore['complete'] = (input) =>
    Promise.resolve(
      this.updateRunning(input, (job) => ({
        ...job,
        status: 'succeeded',
        completedAt: input.completedAt,
        leaseToken: null,
        leaseExpiresAt: null,
      })),
    );

  reschedule: JobRecoveryStore['reschedule'] = (input) =>
    Promise.resolve(
      this.updateRunning(input, (job) => ({
        ...job,
        status: 'queued',
        availableAt: input.availableAt,
        lastErrorCode: input.errorCode,
        leaseToken: null,
        leaseExpiresAt: null,
      })),
    );

  fail: JobRecoveryStore['fail'] = (input) =>
    Promise.resolve(
      this.updateRunning(input, (job) => ({
        ...job,
        status: 'failed',
        completedAt: input.completedAt,
        lastErrorCode: input.errorCode,
        leaseToken: null,
        leaseExpiresAt: null,
      })),
    );

  cancel: JobRecoveryStore['cancel'] = (input) => {
    const job = this.jobs.get(input.id);
    if (
      !job ||
      job.status !== 'cancel_requested' ||
      job.leaseToken !== input.leaseToken ||
      job.version !== input.expectedVersion
    )
      return Promise.resolve(undefined);
    const cancelled: RecoverableJob = {
      ...job,
      status: 'cancelled',
      completedAt: input.completedAt,
      leaseToken: null,
      leaseExpiresAt: null,
      version: job.version + 1,
    };
    this.jobs.set(job.id, cancelled);
    return Promise.resolve(structuredClone(cancelled));
  };

  private updateRunning(
    input: { id: string; leaseToken: string; expectedVersion: number },
    update: (job: RecoverableJob) => RecoverableJob,
  ): RecoverableJob | undefined {
    const job = this.jobs.get(input.id);
    if (
      !job ||
      job.status !== 'running' ||
      job.leaseToken !== input.leaseToken ||
      job.version !== input.expectedVersion
    )
      return undefined;
    const saved = { ...update(job), version: job.version + 1 };
    this.jobs.set(job.id, saved);
    return structuredClone(saved);
  }
}

const options = {
  workerId: 'worker:test',
  leaseMs: 2_000,
  executionTimeoutMs: 100,
  baseRetryMs: 100,
  maxRetryMs: 1_000,
};

function queued(overrides: Partial<RecoverableJob> = {}): RecoverableJob {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'attachment.scan',
    status: 'queued',
    attempts: 0,
    maxAttempts: 3,
    checkpoint: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    availableAt: '2026-01-01T00:00:00.000Z',
    leaseToken: null,
    leaseExpiresAt: null,
    completedAt: null,
    lastErrorCode: null,
    version: 1,
    ...overrides,
  };
}

describe('recoverable background jobs', () => {
  it('retries an ambiguous partial effect without duplicating it', async () => {
    const store = new MemoryJobStore();
    store.add(queued());
    const objects = new Map<string, string>();
    let committedWrites = 0;
    const handler = vi.fn(({ job }: JobExecutionContext): Promise<void> => {
      if (!objects.has(job.id)) {
        objects.set(job.id, 'immutable-bytes');
        committedWrites += 1;
      }
      if (job.attempts === 1)
        throw new Error('private network response was lost');
      return Promise.resolve();
    });
    const first = new RecoverableJobWorker(
      store,
      { 'attachment.scan': handler },
      options,
    );
    expect(
      await first.runOnce(new Date('2026-01-01T00:00:00.000Z')),
    ).toMatchObject({ outcome: 'retry_scheduled' });
    const retryAt = store.value(queued().id).availableAt;
    const restarted = new RecoverableJobWorker(
      store,
      { 'attachment.scan': handler },
      { ...options, workerId: 'worker:restarted' },
    );
    expect(await restarted.runOnce(new Date(retryAt))).toMatchObject({
      outcome: 'succeeded',
    });
    expect(committedWrites).toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(store.value(queued().id)).toMatchObject({
      status: 'succeeded',
      attempts: 2,
    });
  });

  it('reclaims an expired lease and resumes from its durable checkpoint', async () => {
    const store = new MemoryJobStore();
    store.add(
      queued({
        status: 'running',
        attempts: 1,
        checkpoint: { next_part: 2 },
        leaseToken: 'abandoned',
        leaseExpiresAt: '2026-01-01T00:00:01.000Z',
        version: 4,
      }),
    );
    const observed: JobCheckpoint[] = [];
    const worker = new RecoverableJobWorker(
      store,
      {
        'attachment.scan': async ({ job, saveCheckpoint }) => {
          observed.push(job.checkpoint);
          await saveCheckpoint({ next_part: 3 });
        },
      },
      { ...options, workerId: 'worker:after-restart' },
    );
    expect(
      await worker.runOnce(new Date('2026-01-01T00:00:02.000Z')),
    ).toMatchObject({ outcome: 'succeeded' });
    expect(observed).toEqual([{ next_part: 2 }]);
    expect(store.value(queued().id).checkpoint).toEqual({ next_part: 3 });
  });

  it('atomically permits only one concurrent claim', async () => {
    const store = new MemoryJobStore();
    store.add(queued());
    let executions = 0;
    const handler = async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    const workers = ['one', 'two'].map(
      (workerId) =>
        new RecoverableJobWorker(
          store,
          { 'attachment.scan': handler },
          { ...options, workerId },
        ),
    );
    const results = await Promise.all(
      workers.map((worker) =>
        worker.runOnce(new Date('2026-01-01T00:00:00.000Z')),
      ),
    );
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'idle',
      'succeeded',
    ]);
    expect(executions).toBe(1);
  });

  it('bounds execution time, retries, and reaches terminal exhaustion', async () => {
    const store = new MemoryJobStore();
    store.add(queued({ maxAttempts: 2 }));
    const handler = ({ signal }: { signal: AbortSignal }) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('private timeout detail'));
        });
      });
    const worker = new RecoverableJobWorker(
      store,
      { 'attachment.scan': handler },
      options,
    );
    expect(
      await worker.runOnce(new Date('2026-01-01T00:00:00.000Z')),
    ).toMatchObject({ outcome: 'retry_scheduled' });
    const retryAt = store.value(queued().id).availableAt;
    expect(await worker.runOnce(new Date(retryAt))).toMatchObject({
      outcome: 'failed',
    });
    expect(store.value(queued().id)).toMatchObject({
      status: 'failed',
      attempts: 2,
      lastErrorCode: 'timeout',
    });
  });

  it('honors cooperative cancellation after the current bounded step', async () => {
    const store = new MemoryJobStore();
    store.add(queued());
    const worker = new RecoverableJobWorker(
      store,
      {
        'attachment.scan': ({ job }) => {
          store.requestCancellation(job.id);
          return Promise.resolve();
        },
      },
      options,
    );
    expect(
      await worker.runOnce(new Date('2026-01-01T00:00:00.000Z')),
    ).toMatchObject({ outcome: 'cancelled' });
    expect(store.value(queued().id).status).toBe('cancelled');
  });

  it('finalizes an interrupted cancellation without rerunning the handler', async () => {
    const store = new MemoryJobStore();
    store.add(
      queued({
        status: 'cancel_requested',
        attempts: 1,
        leaseToken: 'stopped-worker',
        leaseExpiresAt: '2026-01-01T00:00:01.000Z',
      }),
    );
    const handler = vi.fn(() => Promise.resolve());
    const worker = new RecoverableJobWorker(
      store,
      { 'attachment.scan': handler },
      options,
    );
    expect(
      await worker.runOnce(new Date('2026-01-01T00:00:02.000Z')),
    ).toMatchObject({ outcome: 'cancelled' });
    expect(handler).not.toHaveBeenCalled();
    expect(store.value(queued().id).status).toBe('cancelled');
  });

  it('redacts dependency failures and bounds durable checkpoints', async () => {
    const unavailable = new MemoryJobStore();
    unavailable.claimFailure = new Error(
      'postgresql://private-user:private-password@database/private',
    );
    const worker = new RecoverableJobWorker(
      unavailable,
      { 'attachment.scan': () => Promise.resolve() },
      options,
    );
    await expect(worker.runOnce()).rejects.toEqual(
      new JobRecoveryError('job_store_unavailable'),
    );

    const bounded = new MemoryJobStore();
    bounded.add(queued());
    const invalid = new RecoverableJobWorker(
      bounded,
      {
        'attachment.scan': async ({ saveCheckpoint }) => {
          await saveCheckpoint({ value: 'x'.repeat(1_025) });
        },
      },
      options,
    );
    expect(
      await invalid.runOnce(new Date('2026-01-01T00:00:00.000Z')),
    ).toMatchObject({ outcome: 'retry_scheduled' });
    expect(bounded.value(queued().id).checkpoint).toEqual({});
    expect(bounded.value(queued().id).lastErrorCode).toBe('handler_failed');
  });
});
