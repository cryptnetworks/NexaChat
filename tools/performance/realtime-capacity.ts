import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { arch, cpus, freemem, platform, release, totalmem } from 'node:os';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  AuthenticationService,
  FixedWindowRateLimiter,
  InMemoryAuthStore,
  type PasswordHasher,
} from '@nexa/auth';
import {
  type EphemeralCoordination,
  ValkeyCoordination,
} from '@nexa/coordination';
import { InMemoryCommunityService } from '@nexa/domain';
import type { RealtimeEnvelope } from '@nexa/realtime-contracts';
import type { FastifyInstance } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import { buildApp } from '../../apps/server/src/app.js';
import type { AuthRuntime } from '../../apps/server/src/auth-routes.js';
import {
  attachWebsocketHub,
  type WebsocketHub,
  type WebsocketLimits,
  type WebsocketMetrics,
} from '../../apps/server/src/websocket.js';
import { realtimeCapacityPolicy } from './realtime-policy.js';
import { summarizeDistribution } from './statistics.js';

const origin = 'http://capacity.test';
const password = 'correct horse battery staple';

interface CapacityClient {
  id: number;
  instance: 0 | 1;
  socket: WebSocket;
  spaceIds: readonly string[];
}

interface HubRuntime {
  app: FastifyInstance;
  hub: WebsocketHub;
  endpoint: string;
  metrics: CapacityMetrics;
}

interface CoordinatorPair {
  first: FaultCoordination;
  second: FaultCoordination;
  mode: 'local' | 'valkey';
  duplicateInjection: boolean;
  close(): Promise<void>;
}

class CapacityMetrics implements WebsocketMetrics {
  private readonly counters = new Map<string, number>();
  private readonly currentGauges = new Map<string, number>();
  private readonly maximumGauges = new Map<string, number>();

  increment = (name: string): void => {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  };

  gauge = (name: string, value: number): void => {
    this.currentGauges.set(name, value);
    this.maximumGauges.set(
      name,
      Math.max(this.maximumGauges.get(name) ?? value, value),
    );
  };

  count(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  maximum(name: string): number {
    return this.maximumGauges.get(name) ?? 0;
  }
}

class LocalCoordinationBus {
  readonly values = new Map<string, string>();
  readonly counters = new Map<string, { count: number; expiresAt: number }>();
  readonly listeners = new Map<string, Set<(value: string) => void>>();
  duplicatePublications = true;

  publish(channel: string, value: string): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      listener(value);
      if (this.duplicatePublications) listener(value);
    }
  }

  subscribe(channel: string, listener: (value: string) => void): () => void {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
    return () => {
      listeners.delete(listener);
    };
  }
}

class LocalCoordination implements EphemeralCoordination {
  constructor(private readonly bus: LocalCoordinationBus) {}

  verify = (): Promise<void> => Promise.resolve();

  get = (key: string): Promise<string | undefined> =>
    Promise.resolve(this.bus.values.get(key));

  set = (key: string, value: string): Promise<void> => {
    this.bus.values.set(key, value);
    return Promise.resolve();
  };

  setIfAbsent = (key: string, value: string): Promise<boolean> => {
    if (this.bus.values.has(key)) return Promise.resolve(false);
    this.bus.values.set(key, value);
    return Promise.resolve(true);
  };

  increment = (
    key: string,
    ttlSeconds: number,
  ): Promise<{ count: number; ttlSeconds: number }> => {
    const now = Date.now();
    const current = this.bus.counters.get(key);
    const count = current && current.expiresAt > now ? current.count + 1 : 1;
    this.bus.counters.set(key, {
      count,
      expiresAt: now + ttlSeconds * 1_000,
    });
    return Promise.resolve({ count, ttlSeconds });
  };

  delete = (key: string): Promise<boolean> => {
    const deletedValue = this.bus.values.delete(key);
    const deletedCounter = this.bus.counters.delete(key);
    return Promise.resolve(deletedValue || deletedCounter);
  };

  publish = (channel: string, value: string): Promise<void> => {
    this.bus.publish(channel, value);
    return Promise.resolve();
  };

  subscribe = (
    channel: string,
    listener: (value: string) => void,
  ): Promise<() => Promise<void>> => {
    const unsubscribe = this.bus.subscribe(channel, listener);
    return Promise.resolve(() => {
      unsubscribe();
      return Promise.resolve();
    });
  };

  close = (): Promise<void> => Promise.resolve();
}

class FaultCoordination implements EphemeralCoordination {
  publishAvailable = true;
  subscribeAvailable = true;

  constructor(private readonly delegate: EphemeralCoordination) {}

  verify = (): Promise<void> => this.delegate.verify();
  get = (key: string): Promise<string | undefined> => this.delegate.get(key);
  set = (key: string, value: string, ttlSeconds: number): Promise<void> =>
    this.delegate.set(key, value, ttlSeconds);
  setIfAbsent = (
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> => this.delegate.setIfAbsent(key, value, ttlSeconds);
  increment = (
    key: string,
    ttlSeconds: number,
  ): Promise<{ count: number; ttlSeconds: number }> =>
    this.delegate.increment(key, ttlSeconds);
  delete = (key: string): Promise<boolean> => this.delegate.delete(key);
  publish = (channel: string, value: string): Promise<void> =>
    this.publishAvailable
      ? this.delegate.publish(channel, value)
      : Promise.reject(new Error('coordination_unavailable'));
  subscribe = (
    channel: string,
    listener: (value: string) => void,
  ): Promise<() => Promise<void>> =>
    this.subscribeAvailable
      ? this.delegate.subscribe(channel, listener)
      : Promise.reject(new Error('coordination_unavailable'));
  close = (): Promise<void> => this.delegate.close();
}

class EventTracker {
  private readonly clients = new Map<number, CapacityClient>();
  private readonly handlers = new Map<number, (data: RawData) => void>();
  private readonly deliveries = new Map<string, Set<number>>();
  private readonly sentAt = new Map<string, number>();
  private readonly latencies = new Map<string, number[]>();
  private readonly waiters = new Map<
    string,
    Array<{ count: number; resolve: () => void }>
  >();
  duplicates = 0;

  add(client: CapacityClient): void {
    const handler = (data: RawData) => {
      let raw: unknown;
      try {
        raw = JSON.parse(textFromRawData(data));
      } catch {
        return;
      }
      if (!raw || typeof raw !== 'object') return;
      const delivery = raw as {
        type?: unknown;
        event?: { id?: unknown };
      };
      if (delivery.type !== 'event' || typeof delivery.event?.id !== 'string')
        return;
      const eventId = delivery.event.id;
      const delivered = this.deliveries.get(eventId) ?? new Set<number>();
      if (delivered.has(client.id)) {
        this.duplicates += 1;
        return;
      }
      delivered.add(client.id);
      this.deliveries.set(eventId, delivered);
      const sentAt = this.sentAt.get(eventId);
      if (sentAt !== undefined) {
        const values = this.latencies.get(eventId) ?? [];
        values.push(performance.now() - sentAt);
        this.latencies.set(eventId, values);
      }
      this.resolveWaiters(eventId, delivered.size);
    };
    this.clients.set(client.id, client);
    this.handlers.set(client.id, handler);
    client.socket.on('message', handler);
  }

  remove(client: CapacityClient): void {
    const handler = this.handlers.get(client.id);
    if (handler) client.socket.off('message', handler);
    this.handlers.delete(client.id);
    this.clients.delete(client.id);
  }

  markSent(eventId: string): void {
    this.sentAt.set(eventId, performance.now());
  }

  count(eventId: string): number {
    return this.deliveries.get(eventId)?.size ?? 0;
  }

  latencyFor(eventIds: readonly string[]): number[] {
    return eventIds.flatMap((eventId) => this.latencies.get(eventId) ?? []);
  }

  async waitFor(eventId: string, count: number, timeoutMs = 10_000) {
    if (this.count(eventId) >= count) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('event_delivery_timeout'));
      }, timeoutMs);
      const waiters = this.waiters.get(eventId) ?? [];
      waiters.push({
        count,
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
      });
      this.waiters.set(eventId, waiters);
    });
  }

  private resolveWaiters(eventId: string, delivered: number): void {
    const waiters = this.waiters.get(eventId) ?? [];
    const remaining = [];
    for (const waiter of waiters) {
      if (delivered >= waiter.count) waiter.resolve();
      else remaining.push(waiter);
    }
    if (remaining.length === 0) this.waiters.delete(eventId);
    else this.waiters.set(eventId, remaining);
  }
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function textFromRawData(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('condition_timeout');
    await delay(5);
  }
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (let index = next++; index < values.length; index = next++) {
        const value = values[index];
        if (value === undefined) throw new Error('missing_capacity_input');
        results[index] = await worker(value, index);
      }
    }),
  );
  return results;
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
      new FixedWindowRateLimiter(100_000, 60_000),
      { now: () => new Date() },
      { absoluteSessionMs: 86_400_000, idleSessionMs: 86_400_000 },
    ),
    config: {
      trustedOrigin: origin,
      secureCookies: false,
      cookieMaxAgeSeconds: 86_400,
    },
  };
}

const benchmarkServerConfig = {
  host: '127.0.0.1',
  port: 0,
  bodyLimitBytes: 16_384,
  requestTimeoutMs: 15_000,
  shutdownTimeoutMs: 5_000,
  rateLimit: 1_000_000,
  rateWindowMs: 60_000,
  logLevel: 'error',
  trustedProxyCidrs: [] as string[],
} as const;

async function startHub(
  service: InMemoryCommunityService,
  auth: AuthRuntime,
  coordination: EphemeralCoordination | undefined,
  limits: Partial<WebsocketLimits>,
  instanceId: string,
): Promise<HubRuntime> {
  const metrics = new CapacityMetrics();
  const app = buildApp(
    service,
    undefined,
    undefined,
    undefined,
    benchmarkServerConfig,
    undefined,
    coordination,
    undefined,
    { logging: false },
  );
  const hub = attachWebsocketHub(app.server, service, {
    auth,
    trustedOrigin: origin,
    limits,
    metrics,
    instanceId,
    ...(coordination ? { coordination } : {}),
  });
  app.websocketHub = hub;
  await hub.ready();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return {
    app,
    hub,
    endpoint: `ws://127.0.0.1:${String(address.port)}/v1/realtime`,
    metrics,
  };
}

async function closeHub(runtime: HubRuntime): Promise<void> {
  await runtime.hub.close();
  await runtime.app.close();
}

async function createCoordinators(mode: string): Promise<CoordinatorPair> {
  if (mode === 'local') {
    const bus = new LocalCoordinationBus();
    const first = new FaultCoordination(new LocalCoordination(bus));
    const second = new FaultCoordination(new LocalCoordination(bus));
    return {
      first,
      second,
      mode,
      duplicateInjection: true,
      close: async () => {
        await Promise.all([first.close(), second.close()]);
      },
    };
  }
  if (mode !== 'valkey')
    throw new Error('coordination must be local or valkey');
  const url = process.env.NEXA_RT_VALKEY_URL;
  if (!url)
    throw new Error('NEXA_RT_VALKEY_URL is required for Valkey capacity tests');
  const namespace = `nexa-cap-${randomUUID().slice(0, 12)}`;
  const config = {
    url,
    namespace,
    operationTimeoutMs: 2_000,
    connectTimeoutMs: 2_000,
    circuitFailures: 3,
    circuitResetMs: 1_000,
    maxValueBytes: 32_768,
    maxTtlSeconds: 3_600,
  };
  const firstStore = new ValkeyCoordination(config);
  const secondStore = new ValkeyCoordination(config);
  await Promise.all([firstStore.verify(), secondStore.verify()]);
  const first = new FaultCoordination(firstStore);
  const second = new FaultCoordination(secondStore);
  return {
    first,
    second,
    mode,
    duplicateInjection: false,
    close: async () => {
      await Promise.all([first.close(), second.close()]);
    },
  };
}

async function openSocket(
  endpoint: string,
  token: string,
): Promise<{ socket: WebSocket; elapsedMs: number }> {
  const started = performance.now();
  const socket = new WebSocket(endpoint, {
    origin,
    headers: { cookie: `nexa_session=${token}` },
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('open_timeout'));
    }, 5_000);
    socket.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return { socket, elapsedMs: performance.now() - started };
}

async function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('message_timeout'));
    }, 5_000);
    const message = (data: RawData) => {
      cleanup();
      try {
        resolve(JSON.parse(textFromRawData(data)) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid_server_message'));
      }
    };
    const error = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const close = () => {
      cleanup();
      reject(new Error('socket_closed_before_message'));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', message);
      socket.off('error', error);
      socket.off('close', close);
    };
    socket.once('message', message);
    socket.once('error', error);
    socket.once('close', close);
  });
}

async function subscribe(socket: WebSocket, spaceId: string): Promise<void> {
  const requestId = randomUUID();
  const response = nextJson(socket);
  socket.send(
    JSON.stringify({ version: 1, type: 'subscribe', requestId, spaceId }),
  );
  const message = await response;
  if (
    message.type !== 'subscribed' ||
    message.requestId !== requestId ||
    message.spaceId !== spaceId
  )
    throw new Error('subscription_failed');
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 1_000);
    socket.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.close(1000);
  });
}

function envelope(
  spaceId: string,
  authorId: string,
  bodyBytes = 64,
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
        body: 'x'.repeat(bodyBytes),
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

function assignedSpaceIds(
  clientIndex: number,
  spaces: readonly { id: string }[],
  subscriptionsPerConnection: number,
  pattern: 'all' | 'striped',
): string[] {
  if (pattern === 'all')
    return spaces.slice(0, subscriptionsPerConnection).map((space) => space.id);
  return Array.from({ length: subscriptionsPerConnection }, (_, offset) => {
    const space =
      spaces[
        (clientIndex * subscriptionsPerConnection + offset) % spaces.length
      ];
    if (!space) throw new Error('capacity_space_assignment_failed');
    return space.id;
  });
}

async function broadcastBatch(input: {
  hub: WebsocketHub;
  tracker: EventTracker;
  spaceId: string;
  authorId: string;
  events: number;
  expectedPerEvent: number;
  durationSeconds: number;
}): Promise<{
  elapsedMs: number;
  eventIds: string[];
  deliveries: number;
}> {
  const events = Array.from({ length: input.events }, () =>
    envelope(input.spaceId, input.authorId),
  );
  const intervalMs =
    input.durationSeconds > 0
      ? (input.durationSeconds * 1_000) / input.events
      : 0;
  const started = performance.now();
  for (const event of events) {
    input.tracker.markSent(event.id);
    input.hub.broadcast(input.spaceId, event);
    if (intervalMs > 0) await delay(intervalMs);
  }
  await Promise.all(
    events.map((event) =>
      input.tracker.waitFor(
        event.id,
        input.expectedPerEvent,
        Math.max(10_000, input.durationSeconds * 1_000 + 10_000),
      ),
    ),
  );
  return {
    elapsedMs: performance.now() - started,
    eventIds: events.map((event) => event.id),
    deliveries: input.events * input.expectedPerEvent,
  };
}

async function verifySlowConsumer(
  service: InMemoryCommunityService,
  auth: AuthRuntime,
  token: string,
  spaceId: string,
  authorId: string,
): Promise<{ closeCode: number; metricCount: number }> {
  const runtime = await startHub(
    service,
    auth,
    undefined,
    {
      maxConnections: 2,
      maxConnectionsPerAccount: 2,
      maxConnectionsPerAddress: 2,
      maxSubscriptions: 2,
      maxBufferedBytes: 256,
      heartbeatMs: 30_000,
      staleMs: 60_000,
      revalidateMs: 30_000,
      drainMs: 500,
    },
    'slow-consumer',
  );
  try {
    const { socket } = await openSocket(runtime.endpoint, token);
    await subscribe(socket, spaceId);
    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code) => {
        resolve(code);
      });
    });
    runtime.hub.broadcast(spaceId, envelope(spaceId, authorId, 1_500));
    return {
      closeCode: await closed,
      metricCount: runtime.metrics.count('realtime_slow_consumer'),
    };
  } finally {
    await closeHub(runtime);
  }
}

async function verifySubscriberFailure(
  service: InMemoryCommunityService,
  auth: AuthRuntime,
  token: string,
  spaceId: string,
  authorId: string,
): Promise<{ degraded: boolean; localDelivery: boolean }> {
  const bus = new LocalCoordinationBus();
  const coordination = new FaultCoordination(new LocalCoordination(bus));
  coordination.subscribeAvailable = false;
  const runtime = await startHub(
    service,
    auth,
    coordination,
    {
      maxConnections: 2,
      maxConnectionsPerAccount: 2,
      maxConnectionsPerAddress: 2,
      maxSubscriptions: 2,
      heartbeatMs: 30_000,
      staleMs: 60_000,
      revalidateMs: 30_000,
      drainMs: 500,
    },
    'subscriber-failure',
  );
  try {
    const { socket } = await openSocket(runtime.endpoint, token);
    await subscribe(socket, spaceId);
    const client = { id: 1, instance: 0 as const, socket, spaceIds: [spaceId] };
    const tracker = new EventTracker();
    tracker.add(client);
    const event = envelope(spaceId, authorId);
    tracker.markSent(event.id);
    runtime.hub.broadcast(spaceId, event);
    await tracker.waitFor(event.id, 1);
    return {
      degraded:
        runtime.hub.capacitySnapshot?.().fanout === 'degraded' &&
        runtime.metrics.count('realtime_fanout_degraded') >= 1,
      localDelivery: tracker.count(event.id) === 1,
    };
  } finally {
    await closeHub(runtime);
  }
}

async function main(): Promise<void> {
  const policy = realtimeCapacityPolicy(option('profile') ?? 'ci', process.env);
  const coordinationMode = option('coordination') ?? 'local';
  const outputPath = option('output') ?? process.env.NEXA_RT_RESULT_PATH;
  const service = new InMemoryCommunityService();
  const authStore = new InMemoryAuthStore();
  const auth = runtime(authStore);
  const identity = await auth.service.register({
    username: 'capacity',
    displayName: 'Capacity actor',
    password,
    source: 'capacity',
  });
  await service.persistence.accounts.create({
    id: identity.account.id,
    displayName: 'Capacity actor',
  });
  const community = await service.createCommunity(
    identity.account.id,
    'Capacity community',
  );
  const spaces = await Promise.all(
    Array.from({ length: policy.spaces }, (_, index) =>
      service.createTextSpace(
        community.id,
        identity.account.id,
        `capacity-${String(index)}`,
      ),
    ),
  );
  const firstSpace = spaces[0];
  if (!firstSpace) throw new Error('capacity space was not created');
  const coordinators = await createCoordinators(coordinationMode);
  const limits: Partial<WebsocketLimits> = {
    maxConnections: policy.connections + 10,
    maxConnectionsPerAccount: policy.connections + 10,
    maxConnectionsPerAddress: policy.connections + 10,
    maxSubscriptions: policy.subscriptionsPerConnection,
    maxPayloadBytes: 16_384,
    maxBufferedBytes: 1_048_576,
    maxMessagesPerWindow: policy.subscriptionsPerConnection + 20,
    rateWindowMs: 60_000,
    heartbeatMs: 30_000,
    staleMs: 120_000,
    revalidateMs: 30_000,
    drainMs: 1_000,
  };
  const hubs = await Promise.all([
    startHub(service, auth, coordinators.first, limits, 'capacity-a'),
    startHub(service, auth, coordinators.second, limits, 'capacity-b'),
  ]);
  const tracker = new EventTracker();
  const clients: CapacityClient[] = [];
  const startedAt = new Date().toISOString();
  const rssBeforeConnections = process.memoryUsage().rss;
  let peakRss = rssBeforeConnections;
  const memorySampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 10);
  memorySampler.unref();
  try {
    if (hubs.some((hub) => hub.hub.capacitySnapshot?.().fanout !== 'ready'))
      throw new Error('fanout_subscriber_not_ready');
    const connectionInputs = Array.from(
      { length: policy.connections },
      (_, index) => ({ index, instance: (index % 2) as 0 | 1 }),
    );
    const opened = await mapLimit(
      connectionInputs,
      25,
      async ({ index, instance }) => {
        const result = await openSocket(
          hubs[instance].endpoint,
          identity.session.token,
        );
        return {
          client: {
            id: index,
            instance,
            socket: result.socket,
            spaceIds: assignedSpaceIds(
              index,
              spaces,
              policy.subscriptionsPerConnection,
              policy.subscriptionPattern,
            ),
          },
          elapsedMs: result.elapsedMs,
        };
      },
    );
    for (const result of opened) clients.push(result.client);
    await mapLimit(clients, 25, async (client) => {
      for (const spaceId of client.spaceIds)
        await subscribe(client.socket, spaceId);
    });
    for (const client of clients) tracker.add(client);
    const expectedSubscriptions =
      policy.connections * policy.subscriptionsPerConnection;
    await waitUntil(
      () =>
        hubs.reduce(
          (sum, hub) => sum + (hub.hub.snapshot?.().subscriptions ?? 0),
          0,
        ) === expectedSubscriptions,
    );
    const firstSpaceRecipients = clients.filter((client) =>
      client.spaceIds.includes(firstSpace.id),
    ).length;
    if (firstSpaceRecipients < 1)
      throw new Error('capacity_space_has_no_recipients');

    await broadcastBatch({
      hub: hubs[0].hub,
      tracker,
      spaceId: firstSpace.id,
      authorId: identity.account.id,
      events: policy.warmupEvents,
      expectedPerEvent: firstSpaceRecipients,
      durationSeconds: 0,
    });
    const cpuBefore = process.cpuUsage();
    const measured = await broadcastBatch({
      hub: hubs[0].hub,
      tracker,
      spaceId: firstSpace.id,
      authorId: identity.account.id,
      events: policy.measuredEvents,
      expectedPerEvent: firstSpaceRecipients,
      durationSeconds: policy.soakSeconds,
    });
    const cpuUsage = process.cpuUsage(cpuBefore);
    const cpuPercent =
      ((cpuUsage.user + cpuUsage.system) / 1_000 / measured.elapsedMs) * 100;
    const deliveryLatency = summarizeDistribution(
      tracker.latencyFor(measured.eventIds),
    );

    const reconnecting = clients.slice(0, policy.reconnectConnections);
    await Promise.all(
      reconnecting.map(async (client) => {
        tracker.remove(client);
        await closeSocket(client.socket);
      }),
    );
    await waitUntil(
      () =>
        hubs.reduce(
          (sum, hub) => sum + (hub.hub.snapshot?.().connections ?? 0),
          0,
        ) ===
        policy.connections - policy.reconnectConnections,
    );
    const reconnected = await mapLimit(reconnecting, 25, async (previous) => {
      const result = await openSocket(
        hubs[previous.instance].endpoint,
        identity.session.token,
      );
      const client = {
        id: previous.id,
        instance: previous.instance,
        socket: result.socket,
        spaceIds: previous.spaceIds,
      };
      for (const spaceId of client.spaceIds)
        await subscribe(client.socket, spaceId);
      tracker.add(client);
      return { client, elapsedMs: result.elapsedMs };
    });
    for (const replacement of reconnected) {
      const index = clients.findIndex(
        (client) => client.id === replacement.client.id,
      );
      if (index < 0) throw new Error('reconnect_client_missing');
      clients[index] = replacement.client;
    }
    await waitUntil(
      () =>
        hubs.reduce(
          (sum, hub) => sum + (hub.hub.snapshot?.().connections ?? 0),
          0,
        ) === policy.connections,
    );
    const reconnectDelivery = await broadcastBatch({
      hub: hubs[0].hub,
      tracker,
      spaceId: firstSpace.id,
      authorId: identity.account.id,
      events: 1,
      expectedPerEvent: firstSpaceRecipients,
      durationSeconds: 0,
    });

    coordinators.first.publishAvailable = false;
    const degradedEvent = envelope(firstSpace.id, identity.account.id);
    tracker.markSent(degradedEvent.id);
    hubs[0].hub.broadcast(firstSpace.id, degradedEvent);
    const localRecipients = clients.filter(
      (client) =>
        client.instance === 0 && client.spaceIds.includes(firstSpace.id),
    ).length;
    await tracker.waitFor(degradedEvent.id, localRecipients);
    await delay(100);
    const degradedDeliveryCount = tracker.count(degradedEvent.id);
    await waitUntil(
      () => hubs[0].hub.capacitySnapshot?.().fanout === 'degraded',
    );
    coordinators.first.publishAvailable = true;
    const recoveryDelivery = await broadcastBatch({
      hub: hubs[0].hub,
      tracker,
      spaceId: firstSpace.id,
      authorId: identity.account.id,
      events: 1,
      expectedPerEvent: firstSpaceRecipients,
      durationSeconds: 0,
    });
    await waitUntil(() => hubs[0].hub.capacitySnapshot?.().fanout === 'ready');

    const slowConsumer = await verifySlowConsumer(
      service,
      auth,
      identity.session.token,
      firstSpace.id,
      identity.account.id,
    );
    const subscriberFailure = await verifySubscriberFailure(
      service,
      auth,
      identity.session.token,
      firstSpace.id,
      identity.account.id,
    );
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const rssBytesPerConnection =
      Math.max(0, peakRss - rssBeforeConnections) / policy.connections;
    const connectionLatency = summarizeDistribution(
      opened.map((result) => result.elapsedMs),
    );
    const reconnectLatency = summarizeDistribution(
      reconnected.map((result) => result.elapsedMs),
    );
    const maxQueueDepth = Math.max(
      ...hubs.map((hub) => hub.metrics.maximum('realtime_queue_depth')),
    );
    const maxQueueBytes = Math.max(
      ...hubs.map((hub) => hub.metrics.maximum('realtime_queue_bytes')),
    );
    const maxIndexedSpaces = Math.max(
      ...hubs.map((hub) => hub.metrics.maximum('realtime_indexed_spaces')),
    );
    const duplicateEventsRejected = hubs.reduce(
      (sum, hub) => sum + hub.metrics.count('realtime_event_duplicate'),
      0,
    );
    const deliveriesPerSecond =
      measured.deliveries / (measured.elapsedMs / 1_000);
    const failures: string[] = [];
    if (connectionLatency.p95Ms > policy.thresholds.maxConnectionP95Ms)
      failures.push('connection_p95_exceeded');
    if (reconnectLatency.p95Ms > policy.thresholds.maxReconnectP95Ms)
      failures.push('reconnect_p95_exceeded');
    if (deliveryLatency.p95Ms > policy.thresholds.maxDeliveryP95Ms)
      failures.push('delivery_p95_exceeded');
    if (deliveriesPerSecond < policy.thresholds.minDeliveriesPerSecond)
      failures.push('delivery_throughput_below_minimum');
    if (rssBytesPerConnection > policy.thresholds.maxRssBytesPerConnection)
      failures.push('memory_per_connection_exceeded');
    if (cpuPercent > policy.thresholds.maxSingleCoreCpuPercent)
      failures.push('cpu_budget_exceeded');
    if (
      maxQueueDepth >
      policy.connections * policy.thresholds.maxQueueDepthPerConnection
    )
      failures.push('queue_depth_exceeded');
    if (tracker.duplicates !== 0) failures.push('client_duplicate_delivery');
    if (slowConsumer.closeCode !== 1013 || slowConsumer.metricCount < 1)
      failures.push('slow_consumer_not_evicted');
    if (degradedDeliveryCount !== localRecipients)
      failures.push('degraded_fanout_crossed_instance');
    if (
      !subscriberFailure.degraded ||
      !subscriberFailure.localDelivery ||
      recoveryDelivery.deliveries !== firstSpaceRecipients ||
      reconnectDelivery.deliveries !== firstSpaceRecipients
    )
      failures.push('fanout_recovery_failed');

    const cpu = cpus()[0];
    const report = {
      schemaVersion: 1,
      profile: policy.id,
      coordination: coordinators.mode,
      environment: {
        policyEnvironment: policy.description,
        platform: platform(),
        architecture: arch(),
        operatingSystemRelease: release(),
        nodeVersion: process.version,
        cpuModel: cpu?.model ?? 'unknown',
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        freeMemoryBytesAtCompletion: freemem(),
      },
      workload: {
        connections: policy.connections,
        instances: 2,
        spaces: policy.spaces,
        subscriptionsPerConnection: policy.subscriptionsPerConnection,
        subscriptionPattern: policy.subscriptionPattern,
        totalSubscriptions: expectedSubscriptions,
        recipientsPerMeasuredEvent: firstSpaceRecipients,
        warmupEvents: policy.warmupEvents,
        measuredEvents: policy.measuredEvents,
        logicalMeasuredDeliveries: measured.deliveries,
        reconnectConnections: policy.reconnectConnections,
        soakSeconds: policy.soakSeconds,
        duplicateFanoutInjection: coordinators.duplicateInjection,
      },
      thresholds: policy.thresholds,
      measurements: {
        connectionLatency,
        reconnectLatency,
        deliveryLatency,
        eventBatchElapsedMs: measured.elapsedMs,
        deliveriesPerSecond,
        processCpuUserMicroseconds: cpuUsage.user,
        processCpuSystemMicroseconds: cpuUsage.system,
        singleCoreCpuPercent: cpuPercent,
        rssBeforeConnections,
        peakRssBytes: peakRss,
        rssBytesPerConnection,
        maximumInstanceQueueDepth: maxQueueDepth,
        maximumInstanceQueueBytes: maxQueueBytes,
        maximumInstanceIndexedSpaces: maxIndexedSpaces,
        clientDuplicateDeliveries: tracker.duplicates,
        duplicateEventsRejected,
        reconnectRecoveryDeliveries: reconnectDelivery.deliveries,
        degradedLocalDeliveries: degradedDeliveryCount,
        degradedRemoteDeliveries: degradedDeliveryCount - localRecipients,
        recoveryDeliveries: recoveryDelivery.deliveries,
        slowConsumer,
        subscriberFailure,
      },
      startedAt,
      completedAt: new Date().toISOString(),
      failures,
      passed: failures.length === 0,
    };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, serialized, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
    process.stdout.write(serialized);
    if (!report.passed) process.exitCode = 1;
  } finally {
    clearInterval(memorySampler);
    await Promise.allSettled(
      clients.map((client) => closeSocket(client.socket)),
    );
    await Promise.allSettled(hubs.map((hub) => closeHub(hub)));
    await coordinators.close();
  }
}

await main();
