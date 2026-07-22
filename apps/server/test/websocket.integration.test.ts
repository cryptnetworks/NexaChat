import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import {
  AuthenticationService,
  FixedWindowRateLimiter,
  InMemoryAuthStore,
  type PasswordHasher,
} from '@nexa/auth';
import { InMemoryCommunityService, PresenceService } from '@nexa/domain';
import {
  realtimeDeliverySchema,
  type RealtimeEnvelope,
} from '@nexa/realtime-contracts';
import { buildApp } from '../src/app.js';
import type { AuthRuntime } from '../src/auth-routes.js';
import {
  DistributedRequestRateLimiter,
  type RequestRateLimiter,
} from '../src/rate-limit.js';
import { Telemetry } from '../src/telemetry.js';
import { attachWebsocketHub, type WebsocketLimits } from '../src/websocket.js';

const origin = 'http://web.test';
const password = 'correct horse battery staple';

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(textFromRawData(data)));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('invalid JSON'));
      }
    });
    socket.once('error', reject);
  });
}

function nextMessages(socket: WebSocket, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const values: unknown[] = [];
    const listener = (data: RawData) => {
      try {
        values.push(JSON.parse(textFromRawData(data)));
        if (values.length === count) {
          socket.off('message', listener);
          resolve(values);
        }
      } catch (error) {
        reject(error instanceof Error ? error : new Error('invalid JSON'));
      }
    };
    socket.on('message', listener);
    socket.once('error', reject);
  });
}

function textFromRawData(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', resolve));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('secure real WebSocket integration', () => {
  let service: InMemoryCommunityService;
  let authStore: InMemoryAuthStore;
  let auth: AuthRuntime;
  let app: ReturnType<typeof buildApp>;
  let endpoint: string;
  let limits: Partial<WebsocketLimits>;
  let telemetry: Telemetry;
  let trustedProxyCidrs: string[];
  let rateLimiter: RequestRateLimiter | undefined;

  beforeEach(async () => {
    service = new InMemoryCommunityService();
    authStore = new InMemoryAuthStore();
    auth = runtime(authStore);
    limits = {
      heartbeatMs: 20,
      staleMs: 1_000,
      revalidateMs: 20,
      drainMs: 100,
    };
    telemetry = new Telemetry({ traceSampleRate: 0 });
    trustedProxyCidrs = [];
    rateLimiter = undefined;
    app = buildApp(service);
    await app.listen({ host: '127.0.0.1', port: 0 });
    attach();
    const address = app.server.address() as AddressInfo;
    endpoint = `ws://127.0.0.1:${String(address.port)}/v1/realtime`;
  });

  afterEach(async () => {
    await app.websocketHub?.close();
    await app.close();
  });

  function attach(presence?: PresenceService) {
    app.websocketHub = attachWebsocketHub(app.server, service, {
      auth,
      trustedOrigin: origin,
      trustedProxyCidrs,
      limits,
      metrics: telemetry.websocketMetrics(),
      rateLimiter: rateLimiter ?? app.requestRateLimiter,
      ...(presence ? { presence } : {}),
    });
  }

  async function identity(username: string) {
    const issued = await auth.service.register({
      username,
      displayName: username,
      password,
      source: username,
    });
    await service.persistence.accounts.create({
      id: issued.account.id,
      displayName: username,
    });
    return issued;
  }

  function connect(
    cookie: string,
    selectedOrigin = origin,
    forwardedFor?: string,
  ): WebSocket {
    return new WebSocket(endpoint, {
      origin: selectedOrigin,
      headers: {
        cookie: `nexa_session=${cookie}`,
        ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      },
    });
  }

  async function subscribe(socket: WebSocket, spaceId: string) {
    const requestId = randomUUID();
    socket.send(
      JSON.stringify({ version: 1, type: 'subscribe', requestId, spaceId }),
    );
    await expect(nextMessage(socket)).resolves.toEqual({
      version: 1,
      type: 'subscribed',
      requestId,
      spaceId,
    });
  }

  it('authenticates, supports multiple subscribe/unsubscribe commands, and delivers ordered identified events', async () => {
    const owner = await identity('owner');
    const community = await service.createCommunity(owner.account.id, 'One');
    const first = await service.createTextSpace(
      community.id,
      owner.account.id,
      'first',
    );
    const second = await service.createTextSpace(
      community.id,
      owner.account.id,
      'second',
    );
    const socket = connect(owner.session.token);
    await opened(socket);
    await subscribe(socket, first.id);
    await subscribe(socket, second.id);

    const event = envelope(first.id, owner.account.id, 'ordered');
    const delivered = nextMessage(socket);
    app.websocketHub?.broadcast(first.id, event);
    const firstDelivery = realtimeDeliverySchema.parse(await delivered);
    expect(firstDelivery).toMatchObject({
      sequence: 1,
      spaceId: first.id,
      event: { id: event.id },
    });
    const duplicate = nextMessage(socket);
    app.websocketHub?.broadcast(
      first.id,
      envelope(first.id, owner.account.id, 'ordered second'),
    );
    expect(realtimeDeliverySchema.parse(await duplicate).sequence).toBe(2);

    const requestId = randomUUID();
    socket.send(
      JSON.stringify({
        version: 1,
        type: 'unsubscribe',
        requestId,
        spaceId: first.id,
      }),
    );
    await expect(nextMessage(socket)).resolves.toEqual({
      version: 1,
      type: 'unsubscribed',
      requestId,
      spaceId: first.id,
    });
    expect(app.websocketHub?.snapshot?.()).toEqual({
      connections: 1,
      subscriptions: 1,
    });
    socket.close(1000);
  });

  it('publishes bounded connection, subscription, delivery, queue, and close metrics', async () => {
    const owner = await identity('metrics-owner');
    const community = await service.createCommunity(
      owner.account.id,
      'Metrics',
    );
    const space = await service.createTextSpace(
      community.id,
      owner.account.id,
      'metrics',
    );
    const socket = connect(owner.session.token);
    await opened(socket);
    await subscribe(socket, space.id);

    const delivery = nextMessage(socket);
    app.websocketHub?.broadcast(
      space.id,
      envelope(space.id, owner.account.id, 'metrics'),
    );
    await delivery;
    const closeEvent = closed(socket);
    socket.close(1000);
    await closeEvent;
    await vi.waitFor(() => {
      expect(telemetry.metrics.render()).toContain(
        'event="realtime_connection_closed",outcome="normal"',
      );
    });

    const metrics = telemetry.metrics.render();
    expect(metrics).toContain('event="realtime_connection_opened"');
    expect(metrics).toContain('event="realtime_subscription_changed"');
    expect(metrics).toContain('event="realtime_delivery"');
    expect(metrics).toContain(
      'event="realtime_connection_closed",outcome="normal"',
    );
    expect(metrics).toContain('state="connections"');
    expect(metrics).toContain('state="subscriptions"');
    expect(metrics).toContain('state="queue"');
    expect(metrics).toContain('nexa_websocket_delivery_duration_seconds_count');
    expect(metrics).not.toContain(owner.account.id);
    expect(metrics).not.toContain(space.id);
  });

  it('synchronizes compact account read state across active devices', async () => {
    const owner = await identity('reader');
    const first = connect(owner.session.token);
    const second = connect(owner.session.token);
    await Promise.all([opened(first), opened(second)]);
    const firstDelivery = nextMessage(first);
    const secondDelivery = nextMessage(second);
    const state = {
      stream: 'notifications',
      sequence: 14,
      eventId: randomUUID(),
      updatedAt: new Date().toISOString(),
      version: 3,
    };
    app.websocketHub?.broadcastAccount(owner.account.id, {
      version: 1,
      type: 'notification_read',
      state,
    });
    await expect(firstDelivery).resolves.toEqual({
      version: 1,
      type: 'notification_read',
      state,
    });
    await expect(secondDelivery).resolves.toEqual({
      version: 1,
      type: 'notification_read',
      state,
    });
    first.close(1000);
    second.close(1000);
  });

  it('returns coarse presence without exposing expiry or activity details', async () => {
    await app.websocketHub?.close();
    const targetId = randomUUID();
    const presence = new PresenceService(
      {
        get: () =>
          Promise.resolve({
            accountId: targetId,
            state: 'online',
            expiresAt: new Date(Date.now() + 90_000).toISOString(),
            revision: 'private-revision',
          }),
        set: () => Promise.resolve(),
        publish: () => Promise.resolve(),
        allowUpdate: () => Promise.resolve(true),
      },
      { mayView: () => Promise.resolve(true) },
    );
    attach(presence);
    const owner = await identity('presence-reader');
    const socket = connect(owner.session.token);
    await opened(socket);
    const requestId = randomUUID();
    const deliveries = nextMessages(socket, 2);
    socket.send(
      JSON.stringify({
        version: 1,
        type: 'presence_subscribe',
        requestId,
        accountIds: [targetId],
      }),
    );
    const [subscription, update] = await deliveries;
    expect(subscription).toEqual({
      version: 1,
      type: 'presence_subscribed',
      requestId,
      accountIds: [targetId],
    });
    expect(update).toEqual({
      version: 1,
      type: 'presence',
      presence: { accountId: targetId, state: 'online' },
    });
    expect(JSON.stringify(update)).not.toContain('private-revision');
    socket.close(1000);
  });

  it('rejects anonymous, spoofed-origin, revoked, and suspended sessions during connection establishment', async () => {
    const issued = await identity('secure');
    await expectUpgradeRejected(new WebSocket(endpoint, { origin }), 401);
    await expectUpgradeRejected(
      connect(issued.session.token, 'http://evil.test'),
      403,
    );
    await auth.service.logout(issued.session.record.id);
    await expectUpgradeRejected(connect(issued.session.token), 401);

    const expired = await identity('expired');
    const expiredSession = authStore.sessions.get(expired.session.record.id);
    if (!expiredSession) throw new Error('missing session');
    authStore.sessions.set(expiredSession.id, {
      ...expiredSession,
      expiresAt: new Date(0).toISOString(),
    });
    await expectUpgradeRejected(connect(expired.session.token), 401);

    const suspended = await identity('suspended');
    const account = authStore.accounts.get(suspended.account.id);
    if (!account) throw new Error('missing account');
    authStore.accounts.set(account.id, { ...account, status: 'suspended' });
    await expectUpgradeRejected(connect(suspended.session.token), 401);
  });

  it('does not disclose whether private subscription targets exist', async () => {
    const owner = await identity('private-owner');
    const outsider = await identity('outsider');
    const community = await service.createCommunity(
      owner.account.id,
      'Private',
    );
    const space = await service.createTextSpace(
      community.id,
      owner.account.id,
      'private',
    );
    const socket = connect(outsider.session.token);
    await opened(socket);
    for (const target of [space.id, randomUUID()]) {
      const requestId = randomUUID();
      socket.send(
        JSON.stringify({
          version: 1,
          type: 'subscribe',
          requestId,
          spaceId: target,
        }),
      );
      await expect(nextMessage(socket)).resolves.toEqual({
        version: 1,
        type: 'error',
        requestId,
        error: 'unavailable',
      });
    }
    socket.close(1000);
  });

  it('removes subscriptions after membership suspension and closes revoked active sessions', async () => {
    const owner = await identity('admin');
    const member = await identity('member');
    const community = await service.createCommunity(owner.account.id, 'Team');
    const membership = await service.changeMembership(
      owner.account.id,
      community.id,
      member.account.id,
      'active',
    );
    const space = await service.createTextSpace(
      community.id,
      owner.account.id,
      'team',
    );
    const socket = connect(member.session.token);
    await opened(socket);
    await subscribe(socket, space.id);
    const removed = nextMessage(socket);
    await service.changeMembership(
      owner.account.id,
      community.id,
      member.account.id,
      'suspended',
      membership.version,
    );
    await expect(removed).resolves.toMatchObject({
      type: 'error',
      error: 'unavailable',
    });
    expect(app.websocketHub?.snapshot?.().subscriptions).toBe(0);

    const ownerSocket = connect(owner.session.token);
    await opened(ownerSocket);
    await subscribe(ownerSocket, space.id);
    const archived = nextMessage(ownerSocket);
    await service.updateSpace(owner.account.id, space.id, {
      archived: true,
      expectedVersion: space.version,
    });
    await expect(archived).resolves.toMatchObject({
      type: 'error',
      error: 'unavailable',
    });
    const removedSpace = await service.createTextSpace(
      community.id,
      owner.account.id,
      'removed',
    );
    await subscribe(ownerSocket, removedSpace.id);
    const deleted = nextMessage(ownerSocket);
    await service.persistence.spaces.remove(removedSpace.id);
    await expect(deleted).resolves.toMatchObject({
      type: 'error',
      error: 'unavailable',
    });
    const closeEvent = closed(ownerSocket);
    await auth.service.revokeOwnedSession(
      owner.account.id,
      owner.session.record.publicHandle,
      randomUUID(),
    );
    await expect(closeEvent).resolves.toBe(1008);
  });

  it('defines close behavior for malformed, unsupported, binary, and oversized frames', async () => {
    const issued = await identity('frames');
    for (const payload of [
      '{',
      JSON.stringify({ version: 2, type: 'heartbeat' }),
    ]) {
      const socket = connect(issued.session.token);
      await opened(socket);
      const closeEvent = closed(socket);
      socket.send(payload);
      await expect(nextMessage(socket)).resolves.toMatchObject({
        type: 'error',
        error: 'invalid_message',
      });
      await expect(closeEvent).resolves.toBe(1007);
    }
    const binary = connect(issued.session.token);
    await opened(binary);
    const binaryClose = closed(binary);
    binary.send(Buffer.from('binary'));
    await expect(binaryClose).resolves.toBe(1007);

    const oversized = connect(issued.session.token);
    await opened(oversized);
    const oversizedClose = closed(oversized);
    oversized.send('x'.repeat(20_000));
    await expect(oversizedClose).resolves.toBe(1009);
  });

  it('enforces connection, subscription, command-rate, and slow-consumer bounds', async () => {
    await app.websocketHub?.close();
    limits = {
      ...limits,
      maxConnectionsPerAccount: 1,
      maxSubscriptions: 1,
      maxMessagesPerWindow: 3,
      maxBufferedBytes: 1_000,
    };
    attach();
    const owner = await identity('bounded');
    const community = await service.createCommunity(owner.account.id, 'Bounds');
    const first = await service.createTextSpace(
      community.id,
      owner.account.id,
      'first',
    );
    const second = await service.createTextSpace(
      community.id,
      owner.account.id,
      'second',
    );
    const socket = connect(owner.session.token);
    await opened(socket);
    await expectUpgradeRejected(connect(owner.session.token), 403);
    await subscribe(socket, first.id);
    const requestId = randomUUID();
    socket.send(
      JSON.stringify({
        version: 1,
        type: 'subscribe',
        requestId,
        spaceId: second.id,
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({
      error: 'subscription_limit',
    });
    socket.send(JSON.stringify({ version: 1, type: 'heartbeat' }));
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'heartbeat',
    });
    const rateClose = closed(socket);
    socket.send(JSON.stringify({ version: 1, type: 'heartbeat' }));
    await expect(nextMessage(socket)).resolves.toMatchObject({
      error: 'rate_limited',
    });
    await expect(rateClose).resolves.toBe(1008);

    await app.websocketHub?.close();
    limits = {
      ...limits,
      maxConnectionsPerAccount: 2,
      maxBufferedBytes: 1_000,
    };
    attach();
    const slow = connect(owner.session.token);
    await opened(slow);
    await subscribe(slow, first.id);
    const slowClose = closed(slow);
    app.websocketHub?.broadcast(
      first.id,
      envelope(first.id, owner.account.id, 'x'.repeat(4_000)),
    );
    await expect(slowClose).resolves.toBe(1013);
    await vi.waitFor(() => {
      const metrics = telemetry.metrics.render();
      expect(metrics).toContain(
        'event="realtime_slow_consumer",outcome="observed"',
      );
      expect(metrics).toContain(
        'event="realtime_connection_closed",outcome="policy"',
      );
    });
  });

  it('applies per-address limits to forwarded clients only from trusted proxies', async () => {
    await app.websocketHub?.close();
    limits = {
      ...limits,
      maxConnectionsPerAddress: 1,
      maxConnectionsPerAccount: 4,
    };
    const issued = await identity('proxy-limits');
    attach();

    const direct = connect(issued.session.token, origin, '198.51.100.7');
    await opened(direct);
    await expectUpgradeRejected(
      connect(issued.session.token, origin, '198.51.100.8'),
      403,
    );
    const directClosed = closed(direct);
    direct.close(1000);
    await directClosed;

    await app.websocketHub?.close();
    trustedProxyCidrs = ['127.0.0.1/32'];
    attach();
    const first = connect(issued.session.token, origin, '198.51.100.7');
    const second = connect(issued.session.token, origin, '198.51.100.8');
    await Promise.all([opened(first), opened(second)]);
    await expectUpgradeRejected(
      connect(issued.session.token, origin, '198.51.100.7'),
      403,
    );
    first.close(1000);
    second.close(1000);
  });

  it('returns stable retry metadata when distributed upgrade admission is exhausted', async () => {
    await app.websocketHub?.close();
    rateLimiter = new DistributedRequestRateLimiter({
      addressLimit: 1,
      accountLimit: 10,
      windowMs: 10_000,
    });
    attach();
    const issued = await identity('distributed-admission');
    const first = connect(issued.session.token);
    await opened(first);
    await expectUpgradeRejected(connect(issued.session.token), 429, {
      'retry-after': '10',
      'ratelimit-limit': '1',
      'ratelimit-remaining': '0',
      'ratelimit-reset': '10',
    });
    const firstClosed = closed(first);
    first.close(1000);
    await firstClosed;
  });

  it('drains on shutdown and releases state across repeated isolated connections', async () => {
    const issued = await identity('cleanup');
    for (let index = 0; index < 10; index += 1) {
      const socket = connect(issued.session.token);
      await opened(socket);
      const closeEvent = closed(socket);
      socket.close(1000);
      await closeEvent;
    }
    await delay(5);
    expect(app.websocketHub?.snapshot?.()).toEqual({
      connections: 0,
      subscriptions: 0,
    });
    const active = connect(issued.session.token);
    await opened(active);
    const closeEvent = closed(active);
    await app.websocketHub?.close();
    await expect(closeEvent).resolves.toBe(1001);
    expect(app.websocketHub?.snapshot?.()).toEqual({
      connections: 0,
      subscriptions: 0,
    });
    await vi.waitFor(() => {
      const metrics = telemetry.metrics.render();
      expect(metrics).toContain(
        'event="realtime_connection_closed",outcome="shutdown"',
      );
      expect(metrics).toContain('nexa_websocket_state{state="connections"} 0');
      expect(metrics).toContain(
        'nexa_websocket_state{state="subscriptions"} 0',
      );
    });
  });
});

async function expectUpgradeRejected(
  socket: WebSocket,
  status: number,
  headers: Record<string, string> = {},
) {
  await new Promise<void>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      try {
        expect(response.statusCode).toBe(status);
        for (const [name, value] of Object.entries(headers))
          expect(response.headers[name]).toBe(value);
        response.resume();
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error('bad status'));
      }
    });
    socket.once('error', () => {});
  });
}

function runtime(store: InMemoryAuthStore): AuthRuntime {
  const hasher: PasswordHasher = {
    hash: (value) => Promise.resolve(`hash:${value}`),
    verify: (value, encoded) => Promise.resolve(encoded === `hash:${value}`),
    needsRehash: () => false,
    dummyHash: () => 'hash:dummy',
  };
  return {
    service: new AuthenticationService(
      store,
      hasher,
      new FixedWindowRateLimiter(100, 60_000),
      { now: () => new Date() },
      { absoluteSessionMs: 60_000, idleSessionMs: 60_000 },
    ),
    config: {
      trustedOrigin: origin,
      secureCookies: false,
      cookieMaxAgeSeconds: 60,
    },
  };
}

function envelope(
  spaceId: string,
  authorId: string,
  body: string,
): RealtimeEnvelope {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: randomUUID(),
    type: 'message.created',
    occurredAt: now,
    correlationId: randomUUID(),
    payload: {
      message: {
        id: randomUUID(),
        spaceId,
        authorId,
        body,
        replyToId: null,
        idempotencyKey: randomUUID(),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      },
    },
  };
}
