import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  NotificationService,
  NotificationPreferenceService,
  NotificationReadService,
  PresenceService,
  MemberStatusService,
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
  readonly events = new Set<string>();
  claimSourceEvent(accountId: string, eventId: string) {
    const key = `${accountId}:${eventId}`;
    if (this.events.has(key)) return Promise.resolve(false);
    this.events.add(key);
    return Promise.resolve(true);
  }
  findDeduplicated(accountId: string, key: string) {
    return Promise.resolve(
      [...this.values.values()].find(
        (item) => item.accountId === accountId && item.deduplicationKey === key,
      ),
    );
  }
  create(value: NotificationRecord) {
    this.values.set(value.id, value);
    return Promise.resolve(value);
  }
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<NotificationRecord>,
  ) {
    const value = this.values.get(id);
    if (!value || value.version !== expectedVersion)
      return Promise.resolve(undefined);
    const updated = { ...value, ...patch, version: value.version + 1 };
    this.values.set(id, updated);
    return Promise.resolve(updated);
  }
  find(id: string) {
    return Promise.resolve(this.values.get(id));
  }
  list(accountId: string, input: { limit: number }) {
    return Promise.resolve({
      items: [...this.values.values()]
        .filter((item) => item.accountId === accountId)
        .slice(0, input.limit),
      nextCursor: null,
    });
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
    if (!created) throw new Error('notification test setup failed');
    const app = buildApp(
      undefined,
      undefined,
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
      url: `/v1/notifications/${created.id}`,
      payload: { actorId: accountId, action: 'read', expectedVersion: 1 },
    });
    expect(hidden.statusCode).toBe(404);
    expect(JSON.stringify(hidden.json())).not.toContain(resourceId);
    await app.close();
  });

  it('polls privacy-minimized desktop deliveries from an authorized checkpoint', async () => {
    const notificationsStore = new MemoryNotifications();
    const preferencesByScope = new Map<string, NotificationPreference>();
    const preferenceStore: NotificationPreferenceStore = {
      find: (accountId, scopeType, scopeId) =>
        Promise.resolve(
          preferencesByScope.get(`${accountId}:${scopeType}:${scopeId}`),
        ),
      save: (value) => {
        preferencesByScope.set(
          `${value.accountId}:${value.scopeType}:${value.scopeId}`,
          value,
        );
        return Promise.resolve(value);
      },
      transaction: (work) => work(preferenceStore),
    };
    const accountId = randomUUID();
    const spaceId = randomUUID();
    let visible = true;
    const notifications = new NotificationService(notificationsStore, {
      mayNotify: () => Promise.resolve(true),
      mayView: () => Promise.resolve(visible),
    });
    const preferences = new NotificationPreferenceService(preferenceStore, {
      mayConfigure: (actorId) => Promise.resolve(actorId === accountId),
    });
    preferencesByScope.set(`${accountId}:account:${accountId}`, {
      accountId,
      scopeType: 'account',
      scopeId: accountId,
      mode: 'all',
      mutedUntil: null,
      version: 1,
      updatedAt: new Date().toISOString(),
    });
    await notifications.create({
      accountId,
      actorId: randomUUID(),
      resourceId: randomUUID(),
      scopeId: spaceId,
      kind: 'mention',
      now: new Date(Date.now() - 1_000),
    });
    const app = buildApp(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { notifications, notificationPreferences: preferences },
    );

    const initialized = await app.inject({
      method: 'POST',
      url: '/v1/desktop-notification-deliveries/query',
      payload: { actorId: accountId, initialize: true },
    });
    expect(initialized.statusCode).toBe(200);
    const baseline = initialized.json<{
      items: unknown[];
      checkpoint: string;
    }>();
    expect(baseline.items).toEqual([]);

    const privateResource = randomUUID();
    const privateActor = randomUUID();
    const created = await notifications.create({
      accountId,
      actorId: privateActor,
      resourceId: privateResource,
      scopeId: spaceId,
      kind: 'reply',
      now: new Date(Date.now() + 1_000),
    });
    if (!created) throw new Error('notification was not created');
    const delivered = await app.inject({
      method: 'POST',
      url: '/v1/desktop-notification-deliveries/query',
      payload: { actorId: accountId, checkpoint: baseline.checkpoint },
    });
    expect(delivered.statusCode).toBe(200);
    const deliveredBody = delivered.json<{
      items: unknown[];
      checkpoint: string;
      overflow: boolean;
    }>();
    expect(deliveredBody).toMatchObject({
      items: [
        {
          notificationId: created.id,
          kind: 'reply',
          version: 1,
          route: '/notifications',
        },
      ],
      overflow: false,
    });
    const serialized = JSON.stringify(deliveredBody);
    expect(serialized).not.toContain(privateResource);
    expect(serialized).not.toContain(privateActor);
    expect(serialized).not.toContain(spaceId);
    expect(serialized).not.toContain(accountId);

    const settled = await app.inject({
      method: 'POST',
      url: '/v1/desktop-notification-deliveries/query',
      payload: { actorId: accountId, checkpoint: deliveredBody.checkpoint },
    });
    expect(settled.json()).toMatchObject({
      items: [],
      checkpoint: deliveredBody.checkpoint,
    });

    visible = false;
    const hidden = await app.inject({
      method: 'POST',
      url: '/v1/desktop-notification-deliveries/query',
      payload: { actorId: accountId, checkpoint: baseline.checkpoint },
    });
    expect(hidden.json<{ items: unknown[] }>().items).toEqual([]);

    visible = true;
    const accountPreference = preferencesByScope.get(
      `${accountId}:account:${accountId}`,
    );
    if (!accountPreference) throw new Error('account preference is missing');
    preferencesByScope.set(`${accountId}:account:${accountId}`, {
      ...accountPreference,
      mode: 'none',
      version: 2,
    });
    const muted = await app.inject({
      method: 'POST',
      url: '/v1/desktop-notification-deliveries/query',
      payload: { actorId: accountId, checkpoint: baseline.checkpoint },
    });
    expect(muted.json<{ items: unknown[] }>().items).toEqual([]);

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/desktop-notification-deliveries/query',
      payload: { actorId: accountId, checkpoint: 'not-a-checkpoint' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(JSON.stringify(invalid.json())).not.toContain('checkpoint');
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

  it('exposes only coarse authorized presence and stable rate limits', async () => {
    const accountId = randomUUID();
    let allowed = true;
    let value:
      | {
          accountId: string;
          state: 'online' | 'idle';
          expiresAt: string;
          revision: string;
        }
      | undefined;
    const presence = new PresenceService(
      {
        get: () => Promise.resolve(value),
        set: (next) => {
          value = next;
          return Promise.resolve();
        },
        publish: () => Promise.resolve(),
        allowUpdate: () => Promise.resolve(allowed),
      },
      { mayView: (viewer, target) => Promise.resolve(viewer === target) },
    );
    const app = buildApp(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        presence,
      },
    );
    const heartbeat = await app.inject({
      method: 'POST',
      url: '/v1/presence/heartbeat',
      payload: { actorId: accountId, available: true },
    });
    expect(heartbeat.json()).toEqual({ accountId, state: 'online' });
    expect(JSON.stringify(heartbeat.json())).not.toContain('expiresAt');
    allowed = false;
    const limited = await app.inject({
      method: 'POST',
      url: '/v1/presence/heartbeat',
      payload: { actorId: accountId, available: true },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('15');
    await app.close();
  });

  it('updates versioned member status and hides it after permission loss', async () => {
    const accountId = randomUUID();
    let visible = true;
    let status:
      | {
          accountId: string;
          text: string | null;
          expiresAt: string | null;
          updatedAt: string;
          version: number;
        }
      | undefined;
    const memberStatus = new MemberStatusService(
      {
        find: () => Promise.resolve(status),
        save: (value, expectedVersion) => {
          if (status?.version !== expectedVersion)
            return Promise.resolve(undefined);
          status = value;
          return Promise.resolve(value);
        },
      },
      { mayView: () => Promise.resolve(visible) },
    );
    const app = buildApp(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        memberStatus,
      },
    );
    const updated = await app.inject({
      method: 'PUT',
      url: '/v1/member-status',
      payload: {
        actorId: accountId,
        text: '  Working   remotely ',
        expiresAt: null,
      },
    });
    expect(updated.json()).toMatchObject({
      text: 'Working remotely',
      version: 1,
    });
    visible = false;
    const hidden = await app.inject({
      method: 'GET',
      url: `/v1/member-status/${accountId}?actorId=${accountId}`,
    });
    expect(hidden.json()).toBeNull();
    await app.close();
  });
});
