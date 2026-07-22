import { describe, expect, it } from 'vitest';
import {
  AccountDeletionService,
  type AccountDeletionJob,
  type AccountDeletionStore,
} from '../src/account-deletion.js';

class Store implements AccountDeletionStore {
  jobs = new Map<string, AccountDeletionJob>();
  held = false;
  sessionsRevoked = false;
  steps: string[] = [];
  failContentOnce = false;
  /* eslint-disable @typescript-eslint/require-await -- storage-port parity */
  findById = async (id: string) => this.jobs.get(id);
  findByAccount = async (id: string) =>
    [...this.jobs.values()].find(
      (job) =>
        job.accountId === id &&
        !['cancelled', 'completed'].includes(job.status),
    );
  scheduleAndRevokeSessions = async (job: AccountDeletionJob) => {
    this.jobs.set(job.id, job);
    this.sessionsRevoked = true;
    return job;
  };
  update = async (
    id: string,
    version: number,
    patch: Partial<AccountDeletionJob>,
  ) => {
    const current = this.jobs.get(id);
    if (!current || current.version !== version) return undefined;
    const next = { ...current, ...patch, version: version + 1 };
    this.jobs.set(id, next);
    return next;
  };
  hasActiveLegalHold = async () => this.held;
  removeMemberships = async () => void this.steps.push('memberships');
  tombstoneAuthoredContent = async () => {
    if (this.failContentOnce) {
      this.failContentOnce = false;
      throw new Error('temporary');
    }
    this.steps.push('content');
  };
  tombstoneIdentity = async (_id: string, value: { displayName: string }) =>
    void this.steps.push(value.displayName);
  recordBackupExclusion = async () => void this.steps.push('backup-exclusion');
  audit = async (event: { action: string }) =>
    void this.steps.push(event.action);
  /* eslint-enable @typescript-eslint/require-await */
}

const setup = () => {
  const store = new Store();
  let soleOwner = false;
  /* eslint-disable @typescript-eslint/require-await -- adapter parity */
  const service = new AccountDeletionService(store, {
    assertRecentAuthentication: async (_actor, authenticatedAt, now) => {
      if (now.getTime() - new Date(authenticatedAt).getTime() > 600_000)
        throw new Error('recent_auth_required');
    },
    assertCanDeleteAccount: async () => {
      if (soleOwner) throw new Error('sole_owner');
    },
    identityDigest: async () => 'a'.repeat(64),
  });
  /* eslint-enable @typescript-eslint/require-await */
  return {
    store,
    service,
    setSoleOwner: (value: boolean) => (soleOwner = value),
  };
};

describe('account deletion', () => {
  it('requires confirmation and recent authentication', async () => {
    const { service } = setup();
    const now = new Date('2026-01-01T01:00:00.000Z');
    await expect(
      service.request({
        actorId: 'u',
        authenticatedAt: now.toISOString(),
        confirmation: 'delete',
        idempotencyKey: 'deletion-01',
        correlationId: 'c',
        now,
      }),
    ).rejects.toThrow('confirmation_required');
    await expect(
      service.request({
        actorId: 'u',
        authenticatedAt: '2026-01-01T00:00:00.000Z',
        confirmation: 'DELETE MY ACCOUNT',
        idempotencyKey: 'deletion-01',
        correlationId: 'c',
        now,
      }),
    ).rejects.toThrow('recent_auth_required');
  });

  it('atomically revokes sessions, supports cooling-off cancellation, and is idempotent', async () => {
    const { store, service } = setup();
    const now = new Date('2026-01-01');
    const input = {
      actorId: 'u',
      authenticatedAt: now.toISOString(),
      confirmation: 'DELETE MY ACCOUNT',
      idempotencyKey: 'deletion-02',
      correlationId: 'c',
      now,
    };
    const job = await service.request(input);
    expect(store.sessionsRevoked).toBe(true);
    expect(await service.request(input)).toEqual(job);
    const cancelled = await service.cancel({
      actorId: 'u',
      jobId: job.id,
      authenticatedAt: now.toISOString(),
      correlationId: 'cancel',
      now,
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it('blocks for holds and sole ownership, then preserves stable content tombstones', async () => {
    const { store, service, setSoleOwner } = setup();
    const requested = new Date('2026-01-01');
    const job = await service.request({
      actorId: 'u',
      authenticatedAt: requested.toISOString(),
      confirmation: 'DELETE MY ACCOUNT',
      idempotencyKey: 'deletion-03',
      correlationId: 'c',
      now: requested,
    });
    const due = new Date('2026-01-09');
    store.held = true;
    expect((await service.process(job.id, due)).status).toBe('blocked_hold');
    store.held = false;
    setSoleOwner(true);
    await expect(service.process(job.id, due)).rejects.toThrow('sole_owner');
    setSoleOwner(false);
    const completed = await service.process(job.id, due);
    expect(completed.status).toBe('completed');
    expect(store.steps).toEqual(
      expect.arrayContaining([
        'memberships',
        'content',
        'Deleted account',
        'backup-exclusion',
        'account_deletion.complete',
      ]),
    );
    await expect(
      service.cancel({
        actorId: 'u',
        jobId: job.id,
        authenticatedAt: due.toISOString(),
        correlationId: 'late',
        now: due,
      }),
    ).rejects.toThrow('deletion_cannot_cancel');
  });

  it('retries an interrupted background deletion from idempotent steps', async () => {
    const { store, service } = setup();
    const requested = new Date('2026-01-01');
    const job = await service.request({
      actorId: 'u',
      authenticatedAt: requested.toISOString(),
      confirmation: 'DELETE MY ACCOUNT',
      idempotencyKey: 'deletion-retry-01',
      correlationId: 'c',
      now: requested,
    });
    store.failContentOnce = true;
    await expect(
      service.process(job.id, new Date('2026-01-09')),
    ).rejects.toThrow('temporary');
    expect((await store.findById(job.id))?.status).toBe('failed');
    expect((await service.process(job.id, new Date('2026-01-09'))).status).toBe(
      'completed',
    );
  });
});
