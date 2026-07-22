import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  NotificationService,
  NotificationPreferenceService,
  NotificationReadService,
  type NotificationPreference,
  type NotificationPreferenceStore,
  type NotificationReadState,
  type NotificationReadStore,
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

  it('applies scoped preference writes with stale-write protection', async () => {
    const values = new Map<string, NotificationPreference>();
    const store: NotificationPreferenceStore = {
      find: (accountId, scopeType, scopeId) =>
        Promise.resolve(values.get(`${accountId}:${scopeType}:${scopeId}`)),
      save: (value, expectedVersion) => {
        const key = `${value.accountId}:${value.scopeType}:${value.scopeId}`;
        const current = values.get(key);
        if (current?.version !== expectedVersion)
          return Promise.resolve(undefined);
        values.set(key, value);
        return Promise.resolve(value);
      },
      transaction: (work) => work(store),
    };
    const accountId = randomUUID();
    const preferences = new NotificationPreferenceService(store, {
      mayConfigure: (actorId, type, id) =>
        Promise.resolve(type === 'account' && actorId === id),
    });
    const app = buildApp(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        notificationPreferences: preferences,
      },
    );
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/notification-preferences',
      payload: {
        actorId: accountId,
        scopeType: 'account',
        scopeId: accountId,
        mode: 'all',
        mutedUntil: null,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mode: 'all', version: 1 });
    const hidden = await app.inject({
      method: 'PUT',
      url: '/v1/notification-preferences',
      payload: {
        actorId: accountId,
        scopeType: 'community',
        scopeId: randomUUID(),
        mode: 'none',
        mutedUntil: null,
      },
    });
    expect(hidden.statusCode).toBe(404);
    await app.close();
  });

  it('keeps read state monotonic across HTTP retries', async () => {
    let current: NotificationReadState | undefined;
    const store: NotificationReadStore = {
      find: () => Promise.resolve(current),
      advance: (value, expectedVersion) => {
        if (current?.version !== expectedVersion)
          return Promise.resolve(undefined);
        current = value;
        return Promise.resolve(value);
      },
      transaction: (work) => work(store),
    };
    const accountId = randomUUID();
    const readState = new NotificationReadService(store, {
      mayAccess: (actorId, stream) =>
        Promise.resolve(actorId === accountId && stream === 'notifications'),
    });
    const app = buildApp(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        notificationReadState: readState,
      },
    );
    for (const sequence of [12, 4]) {
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/notification-read-state',
        payload: {
          actorId: accountId,
          stream: 'notifications',
          sequence,
          eventId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ sequence: 12 });
    }
    await app.close();
  });

  it('registers web push without returning endpoint or key material', async () => {
    const accountId = randomUUID();
    const subscriptionId = randomUUID();
    const app = buildApp(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        webPush: {
          config: {
            subject: 'mailto:operator@example.test',
            publicKey: 'public-key',
            privateKey: 'private-key',
            encryptionKey: 'encryption-key',
            allowedHosts: ['.example.test'],
          },
          register: (actorId) =>
            Promise.resolve({
              id: subscriptionId,
              accountId: actorId,
              endpointHash: 'a'.repeat(64),
              active: true,
              expiresAt: null,
            }),
          revoke: () => Promise.resolve(),
        },
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/web-push/subscriptions',
      payload: {
        actorId: accountId,
        subscription: {
          endpoint: 'https://push.example.test/private-token',
          expirationTime: null,
          keys: { p256dh: 'p'.repeat(32), auth: 'a'.repeat(16) },
        },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: subscriptionId, accountId });
    expect(JSON.stringify(response.json())).not.toContain('private-token');
    const configuration = await app.inject({
      method: 'GET',
      url: '/v1/web-push/config',
    });
    expect(JSON.stringify(configuration.json())).not.toContain('private-key');
    await app.close();
  });
});
