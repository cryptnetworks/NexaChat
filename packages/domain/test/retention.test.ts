import { describe, expect, it } from 'vitest';
import {
  resolveRetentionPolicy,
  runRetentionBatch,
  updateRetentionPolicy,
  type RetentionCandidate,
  type RetentionPolicy,
  type RetentionStore,
} from '../src/retention.js';

class MemoryRetentionStore implements RetentionStore {
  policies = new Map<string, RetentionPolicy>();
  candidates: RetentionCandidate[] = [];
  holds = new Set<string>();
  purged: { id: string; tombstoneOnly: boolean }[] = [];
  checkpoints = new Map<string, string | null>();
  fail = new Set<string>();
  /* eslint-disable @typescript-eslint/require-await -- storage-port parity */
  findPolicy = async (scope: RetentionPolicy['scope'], id: string) =>
    this.policies.get(`${scope}:${id}`);
  savePolicy = async (value: RetentionPolicy, expected?: number) => {
    const key = `${value.scope}:${value.scopeId}`;
    const current = this.policies.get(key);
    if (
      (current && current.version !== expected) ||
      (!current && expected !== undefined)
    )
      return undefined;
    this.policies.set(key, value);
    return value;
  };
  listCandidates = async ({
    cursor,
    limit,
  }: {
    before: string;
    cursor?: string;
    limit: number;
  }) => {
    const start = cursor ? Number(cursor) : 0;
    const items = this.candidates.slice(start, start + limit);
    return {
      items,
      nextCursor:
        start + limit < this.candidates.length ? String(start + limit) : null,
    };
  };
  isHeld = async (id: string) => this.holds.has(id);
  purgeMessageGraph = async (id: string, tombstoneOnly: boolean) => {
    if (this.fail.has(id)) throw new Error('temporary');
    this.purged.push({ id, tombstoneOnly });
  };
  saveCheckpoint = async (id: string, cursor: string | null) =>
    void this.checkpoints.set(id, cursor);
  getCheckpoint = async (id: string) => this.checkpoints.get(id) ?? null;
  /* eslint-enable @typescript-eslint/require-await */
}

const policy = (
  scope: RetentionPolicy['scope'],
  scopeId: string,
  days: number,
): RetentionPolicy => ({
  scope,
  scopeId,
  retainDays: days,
  tombstoneDays: 30,
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
});

describe('message retention', () => {
  it('inherits space, community, instance, then a safe default', async () => {
    const store = new MemoryRetentionStore();
    expect((await resolveRetentionPolicy(store, 'c', 's')).retainDays).toBe(
      365,
    );
    store.policies.set('instance:default', policy('instance', 'default', 180));
    store.policies.set('community:c', policy('community', 'c', 90));
    store.policies.set('space:s', policy('space', 's', 30));
    expect((await resolveRetentionPolicy(store, 'c', 's')).retainDays).toBe(30);
  });

  it('rejects stale and unsafe policy updates', async () => {
    const store = new MemoryRetentionStore();
    await updateRetentionPolicy(store, policy('community', 'c', 90));
    await expect(
      updateRetentionPolicy(
        store,
        { ...policy('community', 'c', 30), version: 2 },
        9,
      ),
    ).rejects.toThrow('stale');
    await expect(
      updateRetentionPolicy(store, policy('community', 'c', 0)),
    ).rejects.toThrow('invalid');
  });

  it('supports dry runs, holds, tombstones, attachments, retry, and checkpoint recovery', async () => {
    const store = new MemoryRetentionStore();
    store.policies.set('instance:default', policy('instance', 'default', 30));
    store.candidates = [
      {
        messageId: 'held',
        spaceId: 's',
        communityId: 'c',
        createdAt: '2025-01-01T00:00:00.000Z',
        deletedAt: null,
        legalHold: true,
      },
      {
        messageId: 'live',
        spaceId: 's',
        communityId: 'c',
        createdAt: '2025-01-01T00:00:00.000Z',
        deletedAt: null,
        legalHold: false,
      },
      {
        messageId: 'old-tombstone',
        spaceId: 's',
        communityId: 'c',
        createdAt: '2025-01-01T00:00:00.000Z',
        deletedAt: '2025-06-01T00:00:00.000Z',
        legalHold: false,
      },
    ];
    const dry = await runRetentionBatch(store, {
      workerId: 'w',
      now: new Date('2026-01-01'),
      dryRun: true,
    });
    expect(dry).toMatchObject({
      eligible: 3,
      held: 1,
      deleted: 0,
      dryRun: true,
    });
    expect(store.checkpoints.has('w')).toBe(false);
    store.fail.add('live');
    const failed = await runRetentionBatch(store, {
      workerId: 'w',
      now: new Date('2026-01-01'),
    });
    expect(failed.failed).toBe(1);
    expect(store.checkpoints.has('w')).toBe(false);
    store.fail.clear();
    const recovered = await runRetentionBatch(store, {
      workerId: 'w',
      now: new Date('2026-01-01'),
    });
    expect(recovered.deleted).toBe(2);
    expect(store.purged).toEqual([
      { id: 'old-tombstone', tombstoneOnly: false },
      { id: 'live', tombstoneOnly: true },
      { id: 'old-tombstone', tombstoneOnly: false },
    ]);
  });
});
