import { describe, expect, it } from 'vitest';
import {
  NotificationService,
  type NotificationRecord,
  type NotificationStore,
} from '../src/notifications.js';

class Store implements NotificationStore {
  values = new Map<string, NotificationRecord>();
  events = new Set<string>();
  claimSourceEvent = (accountId: string, eventId: string) => {
    const key = `${accountId}:${eventId}`;
    if (this.events.has(key)) return Promise.resolve(false);
    this.events.add(key);
    return Promise.resolve(true);
  };
  /* eslint-disable @typescript-eslint/require-await -- port parity */
  findDeduplicated = async (a: string, k: string) =>
    [...this.values.values()].find(
      (v) => v.accountId === a && v.deduplicationKey === k,
    );
  create = async (v: NotificationRecord) => (this.values.set(v.id, v), v);
  update = async (
    id: string,
    version: number,
    patch: Partial<NotificationRecord>,
  ) => {
    const v = this.values.get(id);
    if (!v || v.version !== version) return undefined;
    const n = { ...v, ...patch, version: version + 1 };
    this.values.set(id, n);
    return n;
  };
  find = async (id: string) => this.values.get(id);
  list = async (accountId: string) => ({
    items: [...this.values.values()].filter((v) => v.accountId === accountId),
    nextCursor: null,
  });
  /* eslint-enable @typescript-eslint/require-await */
  transaction = <T>(work: (s: NotificationStore) => Promise<T>): Promise<T> =>
    work(this);
}

describe('persistent notifications', () => {
  it('deduplicates, aggregates actors, rechecks visibility, and keeps owner-private state', async () => {
    const store = new Store();
    let visible = true;
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const service = new NotificationService(store, {
      mayNotify: async () => true,
      mayView: async () => visible,
    });
    /* eslint-enable @typescript-eslint/require-await */
    const now = new Date('2026-01-01');
    const first = await service.create({
      accountId: 'u',
      kind: 'mention',
      resourceId: 'm',
      actorId: 'a',
      now,
    });
    const second = await service.create({
      accountId: 'u',
      kind: 'mention',
      resourceId: 'm',
      actorId: 'b',
      now,
    });
    expect(second).toMatchObject({
      id: first?.id,
      count: 2,
      actorIds: ['a', 'b'],
    });
    if (!first) throw new Error('expected notification');
    visible = false;
    expect((await service.list('u', { limit: 20 })).items).toEqual([]);
    await expect(
      service.mark('other', first.id, 'read', 2, now),
    ).rejects.toThrow('notification_not_found');
  });

  it('claims source events so transport retries do not aggregate twice', async () => {
    const store = new Store();
    const service = new NotificationService(store, {
      mayNotify: () => Promise.resolve(true),
      mayView: () => Promise.resolve(true),
    });
    const input = {
      accountId: 'u',
      kind: 'mention' as const,
      resourceId: 'm',
      actorId: 'a',
      eventId: 'event',
      now: new Date('2026-01-01'),
    };
    await service.create(input);
    const retry = await service.create(input);
    expect(retry?.count).toBe(1);
  });
});
