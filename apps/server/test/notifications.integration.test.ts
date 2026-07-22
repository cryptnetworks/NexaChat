import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  NotificationService,
  type NotificationRecord,
  type NotificationStore,
} from '@nexa/domain';
import { buildApp } from '../src/app.js';

class MemoryNotifications implements NotificationStore {
  readonly values = new Map<string, NotificationRecord>();
  async findDeduplicated(accountId: string, key: string) {
    return [...this.values.values()].find(
      (item) => item.accountId === accountId && item.deduplicationKey === key,
    );
  }
  async create(value: NotificationRecord) {
    this.values.set(value.id, value);
    return value;
  }
  async update(
    id: string,
    expectedVersion: number,
    patch: Partial<NotificationRecord>,
  ) {
    const value = this.values.get(id);
    if (!value || value.version !== expectedVersion) return undefined;
    const updated = { ...value, ...patch, version: value.version + 1 };
    this.values.set(id, updated);
    return updated;
  }
  async find(id: string) {
    return this.values.get(id);
  }
  async list(accountId: string, input: { limit: number }) {
    return {
      items: [...this.values.values()]
        .filter((item) => item.accountId === accountId)
        .slice(0, input.limit),
      nextCursor: null,
    };
  }
  transaction<T>(work: (store: NotificationStore) => Promise<T>): Promise<T> {
    return work(this);
  }
}

describe('notification HTTP integration', () => {
  it('lists and mutates only currently visible owner records', async () => {
    const store = new MemoryNotifications();
    const accountId = randomUUID();
    const resourceId = randomUUID();
    let visible = true;
    const notifications = new NotificationService(store, {
      mayNotify: () => Promise.resolve(true),
      mayView: () => Promise.resolve(visible),
    });
    const created = await notifications.create({
      accountId,
      actorId: randomUUID(),
      resourceId,
      kind: 'mention',
      now: new Date(),
    });
    const app = buildApp(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        notifications,
      },
    );

    const page = await app.inject({
      method: 'GET',
      url: `/v1/notifications?actorId=${accountId}&limit=20`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json<{ items: NotificationRecord[] }>().items).toHaveLength(1);

    visible = false;
    const hidden = await app.inject({
      method: 'PATCH',
      url: `/v1/notifications/${created!.id}`,
      payload: { actorId: accountId, action: 'read', expectedVersion: 1 },
    });
    expect(hidden.statusCode).toBe(404);
    expect(JSON.stringify(hidden.json())).not.toContain(resourceId);
    await app.close();
  });
});
