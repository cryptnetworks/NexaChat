import { randomUUID } from 'node:crypto';

export type AccountDeletionStatus =
  | 'scheduled'
  | 'running'
  | 'blocked_hold'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface AccountDeletionJob {
  id: string;
  accountId: string;
  idempotencyKey: string;
  status: AccountDeletionStatus;
  requestedAt: string;
  executeAfter: string;
  startedAt: string | null;
  completedAt: string | null;
  exportId: string | null;
  correlationId: string;
  version: number;
}

export interface AccountDeletionStore {
  findById(id: string): Promise<AccountDeletionJob | undefined>;
  findByAccount(accountId: string): Promise<AccountDeletionJob | undefined>;
  scheduleAndRevokeSessions(
    job: AccountDeletionJob,
  ): Promise<AccountDeletionJob>;
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<AccountDeletionJob>,
  ): Promise<AccountDeletionJob | undefined>;
  hasActiveLegalHold(accountId: string): Promise<boolean>;
  removeMemberships(accountId: string): Promise<void>;
  tombstoneAuthoredContent(accountId: string): Promise<void>;
  tombstoneIdentity(
    accountId: string,
    tombstone: { displayName: string; identityDigest: string },
  ): Promise<void>;
  recordBackupExclusion(accountId: string, deletedAt: string): Promise<void>;
  audit(event: {
    id: string;
    actorId: string;
    deletionId: string;
    action: string;
    outcome: 'succeeded' | 'blocked' | 'failed';
    correlationId: string;
    occurredAt: string;
  }): Promise<void>;
}

export interface AccountDeletionAuthorization {
  assertRecentAuthentication(
    actorId: string,
    authenticatedAt: string,
    now: Date,
  ): Promise<void>;
  assertCanDeleteAccount(accountId: string): Promise<void>;
  identityDigest(accountId: string): Promise<string>;
}

function deletionKey(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized))
    throw new Error('invalid_idempotency_key');
  return normalized;
}

export class AccountDeletionService {
  constructor(
    private readonly store: AccountDeletionStore,
    private readonly authorization: AccountDeletionAuthorization,
    private readonly coolingOffMs = 7 * 86_400_000,
  ) {}

  async request(input: {
    actorId: string;
    authenticatedAt: string;
    confirmation: string;
    idempotencyKey: string;
    exportId?: string;
    correlationId: string;
    now: Date;
  }): Promise<AccountDeletionJob> {
    if (input.confirmation !== 'DELETE MY ACCOUNT')
      throw new Error('confirmation_required');
    const key = deletionKey(input.idempotencyKey);
    await this.authorization.assertRecentAuthentication(
      input.actorId,
      input.authenticatedAt,
      input.now,
    );
    await this.authorization.assertCanDeleteAccount(input.actorId);
    const existing = await this.store.findByAccount(input.actorId);
    if (
      existing &&
      existing.status !== 'cancelled' &&
      existing.status !== 'completed'
    ) {
      if (existing.idempotencyKey !== key)
        throw new Error('deletion_already_scheduled');
      return existing;
    }
    const requestedAt = input.now.toISOString();
    const job = await this.store.scheduleAndRevokeSessions({
      id: randomUUID(),
      accountId: input.actorId,
      idempotencyKey: key,
      status: 'scheduled',
      requestedAt,
      executeAfter: new Date(
        input.now.getTime() + this.coolingOffMs,
      ).toISOString(),
      startedAt: null,
      completedAt: null,
      exportId: input.exportId ?? null,
      correlationId: input.correlationId,
      version: 1,
    });
    await this.audit(job, 'account_deletion.schedule', 'succeeded', input.now);
    return job;
  }

  async cancel(input: {
    actorId: string;
    jobId: string;
    authenticatedAt: string;
    correlationId: string;
    now: Date;
  }): Promise<AccountDeletionJob> {
    await this.authorization.assertRecentAuthentication(
      input.actorId,
      input.authenticatedAt,
      input.now,
    );
    const job = await this.store.findById(input.jobId);
    if (!job || job.accountId !== input.actorId)
      throw new Error('deletion_not_found');
    if (job.status === 'cancelled') return job;
    if (job.status !== 'scheduled' || input.now >= new Date(job.executeAfter))
      throw new Error('deletion_cannot_cancel');
    const cancelled = await this.store.update(job.id, job.version, {
      status: 'cancelled',
    });
    if (!cancelled) throw new Error('stale_deletion_job');
    await this.audit(
      cancelled,
      'account_deletion.cancel',
      'succeeded',
      input.now,
      input.correlationId,
    );
    return cancelled;
  }

  async process(jobId: string, now: Date): Promise<AccountDeletionJob> {
    const current = await this.store.findById(jobId);
    if (!current) throw new Error('deletion_not_found');
    if (current.status === 'completed' || current.status === 'cancelled')
      return current;
    if (current.status !== 'scheduled' && current.status !== 'blocked_hold')
      throw new Error('deletion_in_progress');
    if (now < new Date(current.executeAfter))
      throw new Error('cooling_off_active');
    await this.authorization.assertCanDeleteAccount(current.accountId);
    if (await this.store.hasActiveLegalHold(current.accountId)) {
      const blocked = await this.store.update(current.id, current.version, {
        status: 'blocked_hold',
      });
      if (!blocked) throw new Error('stale_deletion_job');
      await this.audit(blocked, 'account_deletion.hold', 'blocked', now);
      return blocked;
    }
    const running = await this.store.update(current.id, current.version, {
      status: 'running',
      startedAt: now.toISOString(),
    });
    if (!running) throw new Error('stale_deletion_job');
    try {
      // Store adapters execute these idempotent steps transactionally or persist
      // a per-step checkpoint. Stable message IDs survive as author tombstones.
      await this.store.removeMemberships(running.accountId);
      await this.store.tombstoneAuthoredContent(running.accountId);
      await this.store.tombstoneIdentity(running.accountId, {
        displayName: 'Deleted account',
        identityDigest: await this.authorization.identityDigest(
          running.accountId,
        ),
      });
      await this.store.recordBackupExclusion(
        running.accountId,
        now.toISOString(),
      );
      const completed = await this.store.update(running.id, running.version, {
        status: 'completed',
        completedAt: now.toISOString(),
      });
      if (!completed) throw new Error('stale_deletion_job');
      await this.audit(
        completed,
        'account_deletion.complete',
        'succeeded',
        now,
      );
      return completed;
    } catch (error) {
      await this.store.update(running.id, running.version, {
        status: 'failed',
      });
      await this.audit(running, 'account_deletion.complete', 'failed', now);
      throw error;
    }
  }

  private async audit(
    job: AccountDeletionJob,
    action: string,
    outcome: 'succeeded' | 'blocked' | 'failed',
    now: Date,
    correlationId = job.correlationId,
  ): Promise<void> {
    await this.store.audit({
      id: randomUUID(),
      actorId: job.accountId,
      deletionId: job.id,
      action,
      outcome,
      correlationId,
      occurredAt: now.toISOString(),
    });
  }
}
