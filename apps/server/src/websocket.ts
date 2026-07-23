import type { IncomingMessage, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  websocketClientMessageSchema,
  websocketServerMessageSchema,
  type WebsocketServerMessage,
} from '@nexa/api-contracts';
import { AuthenticationError, type AuthenticatedSession } from '@nexa/auth';
import type {
  CommunityService,
  MemberStatusService,
  PresenceService,
} from '@nexa/domain';
import {
  realtimeDeliverySchema,
  realtimeEnvelopeSchema,
  type RealtimeDelivery,
  type RealtimeEnvelope,
} from '@nexa/realtime-contracts';
import { sessionTokenFromCookie, type AuthRuntime } from './auth-routes.js';
import { createClientAddressResolver } from './client-address.js';
import type { RateLimitDecision, RequestRateLimiter } from './rate-limit.js';
import type { EphemeralCoordination } from '@nexa/coordination';
import {
  MEMBER_STATUS_CHANNEL,
  parsePresence,
  PRESENCE_CHANNEL,
} from './presence.js';

export interface WebsocketLimits {
  maxConnections: number;
  maxConnectionsPerAccount: number;
  maxConnectionsPerAddress: number;
  maxSubscriptions: number;
  maxPayloadBytes: number;
  maxBufferedBytes: number;
  maxMessagesPerWindow: number;
  rateWindowMs: number;
  heartbeatMs: number;
  staleMs: number;
  revalidateMs: number;
  drainMs: number;
}

export interface WebsocketMetrics {
  increment(name: string, labels?: Record<string, string>): void;
  gauge(name: string, value: number): void;
  observe?(name: string, value: number, labels?: Record<string, string>): void;
}

export interface WebsocketHubOptions {
  auth: AuthRuntime;
  trustedOrigin: string;
  trustedProxyCidrs?: readonly string[];
  limits?: Partial<WebsocketLimits>;
  metrics?: WebsocketMetrics;
  rateLimiter?: RequestRateLimiter;
  coordination?: EphemeralCoordination;
  instanceId?: string;
  presence?: PresenceService;
  memberStatus?: MemberStatusService;
}

export interface WebsocketHub {
  broadcast(spaceId: string, event: RealtimeEnvelope): void;
  broadcastAccount(
    accountId: string,
    message: Extract<WebsocketServerMessage, { type: 'notification_read' }>,
  ): void;
  ready(): Promise<void>;
  close(): Promise<void>;
  snapshot?(): { connections: number; subscriptions: number };
  capacitySnapshot?(): {
    connections: number;
    subscriptions: number;
    queueDepth: number;
    queueBytes: number;
    fanout: 'disabled' | 'connecting' | 'ready' | 'degraded';
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    websocketHub?: WebsocketHub;
  }
}

const defaults: WebsocketLimits = {
  maxConnections: 1_000,
  maxConnectionsPerAccount: 5,
  maxConnectionsPerAddress: 20,
  maxSubscriptions: 32,
  maxPayloadBytes: 16_384,
  maxBufferedBytes: 262_144,
  maxMessagesPerWindow: 60,
  rateWindowMs: 10_000,
  heartbeatMs: 15_000,
  staleMs: 45_000,
  revalidateMs: 5_000,
  drainMs: 5_000,
};

interface ConnectionState {
  actorId: string;
  token: string;
  address: string;
  subscriptions: Set<string>;
  presenceSubscriptions: Set<string>;
  lastSeenAt: number;
  rateStartedAt: number;
  messagesInWindow: number;
  outboundBytes: number;
}

interface SerializedServerMessage {
  payload: string;
  bytes: number;
}

type PendingConnection = AuthenticatedSession & {
  token: string;
  address: string;
  timeout: ReturnType<typeof setTimeout>;
};

class AdmissionError extends Error {
  constructor(
    readonly reason:
      | 'capacity'
      | 'dependency_unavailable'
      | 'origin'
      | 'rate_limited'
      | 'server_draining',
    readonly status = 403,
    readonly decision?: RateLimitDecision,
  ) {
    super('websocket_rejected');
  }
}

const noopMetrics: WebsocketMetrics = {
  increment() {},
  gauge() {},
};

function textFromRawData(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

export function attachWebsocketHub(
  server: Server,
  service: CommunityService,
  options: WebsocketHubOptions,
): WebsocketHub {
  const limits = { ...defaults, ...options.limits };
  const clientAddresses = createClientAddressResolver(
    options.trustedProxyCidrs,
  );
  const metrics = options.metrics ?? noopMetrics;
  const pending = new Map<IncomingMessage, PendingConnection>();
  const connections = new Map<WebSocket, ConnectionState>();
  const subscribersBySpace = new Map<string, Set<WebSocket>>();
  let subscriptionCount = 0;
  const sequences = new Map<string, number>();
  const maxSequenceStates = Math.min(
    100_000,
    Math.max(1, limits.maxConnections * limits.maxSubscriptions),
  );
  let outboundQueueBytes = 0;
  const seenEvents = new Set<string>();
  const instanceId = options.instanceId ?? randomUUID();
  let unsubscribeFanout: (() => Promise<void>) | undefined;
  let unsubscribePresence: (() => Promise<void>) | undefined;
  let unsubscribeMemberStatus: (() => Promise<void>) | undefined;
  let draining = false;
  let queuedMessages = 0;
  let queuedBytes = 0;
  let fanoutState: 'disabled' | 'connecting' | 'ready' | 'degraded' =
    options.coordination ? 'connecting' : 'disabled';
  let fanoutSubscribed = false;
  const wss = new WebSocketServer({
    server,
    path: '/v1/realtime',
    maxPayload: limits.maxPayloadBytes,
    verifyClient(info, callback) {
      void verify(info.req, info.origin).then(
        () => {
          callback(true);
        },
        (error: unknown) => {
          const status =
            error instanceof AuthenticationError
              ? 401
              : error instanceof AdmissionError
                ? error.status
                : 403;
          metrics.increment('realtime_connection_rejected', {
            reason:
              status === 401
                ? 'unauthenticated'
                : error instanceof AdmissionError
                  ? error.reason
                  : 'internal',
          });
          callback(
            false,
            status,
            status === 401
              ? 'Unauthorized'
              : status === 429
                ? 'Too Many Requests'
                : status === 503
                  ? 'Service Unavailable'
                  : 'Forbidden',
            error instanceof AdmissionError && error.decision
              ? rateLimitHeaders(error.decision)
              : undefined,
          );
        },
      );
    },
  });

  async function verify(
    request: IncomingMessage,
    origin: string,
  ): Promise<void> {
    if (draining) throw new AdmissionError('server_draining');
    if (origin !== options.trustedOrigin) throw new AdmissionError('origin');
    const address = clientAddresses.resolve(
      request.socket.remoteAddress,
      request.headers['x-forwarded-for'],
    );
    if (options.rateLimiter) {
      enforceRateLimit(
        await options.rateLimiter.consumeRoute({
          method: 'GET',
          route: '/v1/realtime',
        }),
      );
      enforceRateLimit(
        await options.rateLimiter.consumeAddress({
          method: 'GET',
          route: '/v1/realtime',
          address,
        }),
      );
    }
    if (
      connections.size + pending.size >= limits.maxConnections ||
      countConnections((state) => state.address === address) +
        countPending((state) => state.address === address) >=
        limits.maxConnectionsPerAddress
    )
      throw new AdmissionError('capacity');
    const token = sessionTokenFromCookie(
      request.headers.cookie,
      options.auth.config.secureCookies,
    );
    if (!token) throw new AuthenticationError('unauthenticated');
    const authenticated = await options.auth.service.authenticate(token);
    if (options.rateLimiter)
      enforceRateLimit(
        await options.rateLimiter.consumeAccount({
          method: 'GET',
          route: '/v1/realtime',
          accountId: authenticated.account.id,
          trust: 'authenticated',
        }),
      );
    // Authentication and distributed rate limiting can overlap with shutdown.
    // Read through a function so this check observes the current state.
    if (isDraining()) throw new AdmissionError('server_draining');
    if (
      connections.size + pending.size >= limits.maxConnections ||
      countConnections((state) => state.address === address) +
        countPending((state) => state.address === address) >=
        limits.maxConnectionsPerAddress ||
      countConnections((state) => state.actorId === authenticated.account.id) +
        countPending(
          (state) => state.account.id === authenticated.account.id,
        ) >=
        limits.maxConnectionsPerAccount
    )
      throw new AdmissionError('capacity');
    const timeout = setTimeout(() => pending.delete(request), 10_000);
    timeout.unref();
    pending.set(request, { ...authenticated, token, address, timeout });
  }

  function countConnections(predicate: (state: ConnectionState) => boolean) {
    let count = 0;
    for (const state of connections.values()) if (predicate(state)) count += 1;
    return count;
  }

  function isDraining(): boolean {
    return draining;
  }

  function countPending(predicate: (state: PendingConnection) => boolean) {
    let count = 0;
    for (const state of pending.values()) if (predicate(state)) count += 1;
    return count;
  }

  wss.on('connection', (socket, request) => {
    const authenticated = pending.get(request);
    pending.delete(request);
    if (!authenticated) {
      socket.close(1008, 'unauthenticated');
      return;
    }
    clearTimeout(authenticated.timeout);
    const now = Date.now();
    const state: ConnectionState = {
      actorId: authenticated.account.id,
      token: authenticated.token,
      address: authenticated.address,
      subscriptions: new Set(),
      presenceSubscriptions: new Set(),
      lastSeenAt: now,
      rateStartedAt: now,
      messagesInWindow: 0,
      outboundBytes: 0,
    };
    connections.set(socket, state);
    reportConnections();
    metrics.increment('realtime_connection_opened');
    socket.on('pong', () => {
      state.lastSeenAt = Date.now();
    });
    socket.on('message', (data, isBinary) => {
      void handleMessage(socket, state, data, isBinary);
    });
    socket.on('error', () => {
      cleanup(socket, 'internal');
    });
    socket.on('close', (code) => {
      cleanup(socket, closeOutcome(code));
    });
  });

  function cleanup(socket: WebSocket, reason: string): void {
    const state = connections.get(socket);
    if (!state || !connections.delete(socket)) return;
    removeAllSubscriptions(socket, state);
    outboundQueueBytes = Math.max(0, outboundQueueBytes - state.outboundBytes);
    state.outboundBytes = 0;
    metrics.increment('realtime_connection_closed', { reason });
    reportConnections();
    reportOutboundQueue();
  }

  function reportConnections(): void {
    metrics.gauge('realtime_connections', connections.size);
    metrics.gauge('realtime_subscriptions', subscriptionCount);
    metrics.gauge('realtime_indexed_spaces', subscribersBySpace.size);
  }

  function addSubscription(
    socket: WebSocket,
    state: ConnectionState,
    spaceId: string,
  ): boolean {
    if (state.subscriptions.has(spaceId)) return false;
    state.subscriptions.add(spaceId);
    const subscribers = subscribersBySpace.get(spaceId) ?? new Set<WebSocket>();
    subscribers.add(socket);
    subscribersBySpace.set(spaceId, subscribers);
    subscriptionCount += 1;
    return true;
  }

  function removeSubscription(
    socket: WebSocket,
    state: ConnectionState,
    spaceId: string,
  ): boolean {
    if (!state.subscriptions.delete(spaceId)) return false;
    const subscribers = subscribersBySpace.get(spaceId);
    subscribers?.delete(socket);
    if (subscribers?.size === 0) subscribersBySpace.delete(spaceId);
    subscriptionCount = Math.max(0, subscriptionCount - 1);
    return true;
  }

  function removeAllSubscriptions(
    socket: WebSocket,
    state: ConnectionState,
  ): void {
    for (const spaceId of [...state.subscriptions])
      removeSubscription(socket, state, spaceId);
  }

  function reportOutboundQueue(): void {
    metrics.gauge('realtime_outbound_queue_bytes', outboundQueueBytes);
  }

  function reportQueue(): void {
    metrics.gauge('realtime_queue_depth', queuedMessages);
    metrics.gauge('realtime_queue_bytes', queuedBytes);
  }

  function consume(state: ConnectionState): boolean {
    const now = Date.now();
    if (now - state.rateStartedAt >= limits.rateWindowMs) {
      state.rateStartedAt = now;
      state.messagesInWindow = 0;
    }
    state.messagesInWindow += 1;
    return state.messagesInWindow <= limits.maxMessagesPerWindow;
  }

  async function handleMessage(
    socket: WebSocket,
    state: ConnectionState,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    state.lastSeenAt = Date.now();
    if (options.rateLimiter) {
      const decision = await options.rateLimiter.consumeAccount({
        method: 'MESSAGE',
        route: '/v1/realtime/messages',
        accountId: state.actorId,
        trust: 'authenticated',
      });
      if (!decision.allowed) {
        metrics.increment('realtime_message_rejected', {
          reason: decision.reason ?? 'rate_limited',
        });
        safeSend(socket, state, {
          version: 1,
          type: 'error',
          error:
            decision.reason === 'dependency_unavailable'
              ? 'unavailable'
              : 'rate_limited',
        });
        socket.close(
          decision.reason === 'dependency_unavailable' ? 1013 : 1008,
          decision.reason ?? 'rate_limited',
        );
        return;
      }
    }
    if (!consume(state)) {
      safeSend(socket, state, {
        version: 1,
        type: 'error',
        error: 'rate_limited',
      });
      socket.close(1008, 'rate limit');
      return;
    }
    let raw: unknown;
    try {
      raw = isBinary ? undefined : JSON.parse(textFromRawData(data));
    } catch {
      raw = undefined;
    }
    const parsed = websocketClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      safeSend(socket, state, {
        version: 1,
        type: 'error',
        error: 'invalid_message',
      });
      socket.close(1007, 'invalid message');
      return;
    }
    if (parsed.data.type === 'heartbeat') {
      safeSend(socket, state, {
        version: 1,
        type: 'heartbeat',
        occurredAt: new Date().toISOString(),
      });
      return;
    }
    if (draining) {
      safeSend(socket, state, {
        version: 1,
        type: 'error',
        requestId: parsed.data.requestId,
        error: 'server_draining',
      });
      return;
    }
    if (parsed.data.type === 'presence_subscribe') {
      if (!options.presence) {
        safeSend(socket, state, {
          version: 1,
          type: 'error',
          requestId: parsed.data.requestId,
          error: 'unavailable',
        });
        return;
      }
      try {
        await options.auth.service.authenticate(state.token);
      } catch {
        socket.close(1008, 'unauthenticated');
        return;
      }
      state.presenceSubscriptions = new Set(parsed.data.accountIds);
      safeSend(socket, state, {
        version: 1,
        type: 'presence_subscribed',
        requestId: parsed.data.requestId,
        accountIds: [...state.presenceSubscriptions],
      });
      for (const accountId of state.presenceSubscriptions) {
        safeSend(socket, state, {
          version: 1,
          type: 'presence',
          presence: {
            accountId,
            state: await options.presence.view(
              state.actorId,
              accountId,
              new Date(),
            ),
          },
        });
        if (options.memberStatus)
          safeSend(socket, state, {
            version: 1,
            type: 'member_status',
            accountId,
            status: await options.memberStatus.view(
              state.actorId,
              accountId,
              new Date(),
            ),
          });
      }
      return;
    }
    if (parsed.data.type === 'unsubscribe') {
      removeSubscription(socket, state, parsed.data.spaceId);
      metrics.increment('realtime_subscription_changed', {
        reason: 'removed',
      });
      reportConnections();
      safeSend(socket, state, {
        version: 1,
        type: 'unsubscribed',
        requestId: parsed.data.requestId,
        spaceId: parsed.data.spaceId,
      });
      return;
    }
    if (
      !state.subscriptions.has(parsed.data.spaceId) &&
      state.subscriptions.size >= limits.maxSubscriptions
    ) {
      safeSend(socket, state, {
        version: 1,
        type: 'error',
        requestId: parsed.data.requestId,
        error: 'subscription_limit',
      });
      return;
    }
    try {
      await options.auth.service.authenticate(state.token);
      await service.authorizeSpaceSubscription(
        parsed.data.spaceId,
        state.actorId,
      );
      addSubscription(socket, state, parsed.data.spaceId);
      metrics.increment('realtime_subscription_changed', { reason: 'added' });
      reportConnections();
      safeSend(socket, state, {
        version: 1,
        type: 'subscribed',
        requestId: parsed.data.requestId,
        spaceId: parsed.data.spaceId,
      });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        safeSend(socket, state, {
          version: 1,
          type: 'error',
          requestId: parsed.data.requestId,
          error: 'unauthenticated',
        });
        socket.close(1008, 'unauthenticated');
        return;
      }
      safeSend(socket, state, {
        version: 1,
        type: 'error',
        requestId: parsed.data.requestId,
        error: 'unavailable',
      });
    }
  }

  function safeSend(
    socket: WebSocket,
    state: ConnectionState,
    message: WebsocketServerMessage | RealtimeDelivery,
  ): boolean {
    const validated = websocketServerMessageSchema
      .or(realtimeDeliverySchema)
      .parse(message);
    return sendSerialized(
      socket,
      state,
      serializeValidated(validated, 'control'),
    );
  }

  function serializeValidated(
    message: WebsocketServerMessage | RealtimeDelivery,
    kind: 'account' | 'control' | 'event',
  ): SerializedServerMessage {
    const payload = JSON.stringify(message);
    metrics.increment('realtime_payload_serialized', { reason: kind });
    return { payload, bytes: Buffer.byteLength(payload) };
  }

  function sendSerialized(
    socket: WebSocket,
    state: ConnectionState,
    message: SerializedServerMessage,
  ): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const { payload, bytes } = message;
    if (
      socket.bufferedAmount + state.outboundBytes + bytes >
      limits.maxBufferedBytes
    ) {
      metrics.increment('realtime_slow_consumer');
      socket.close(1013, 'slow consumer');
      return false;
    }
    state.outboundBytes += bytes;
    outboundQueueBytes += bytes;
    reportOutboundQueue();
    queuedMessages += 1;
    queuedBytes += bytes;
    reportQueue();
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      const released = Math.min(bytes, state.outboundBytes);
      state.outboundBytes -= released;
      outboundQueueBytes = Math.max(0, outboundQueueBytes - released);
      queuedMessages = Math.max(0, queuedMessages - 1);
      queuedBytes = Math.max(0, queuedBytes - bytes);
      reportOutboundQueue();
      reportQueue();
      if (error) socket.terminate();
    };
    try {
      socket.send(payload, settle);
    } catch (error) {
      settle(error instanceof Error ? error : new Error('send_failed'));
      return false;
    }
    return true;
  }

  async function revalidate(): Promise<void> {
    const now = Date.now();
    for (const [socket, state] of connections) {
      if (now - state.lastSeenAt > limits.staleMs) {
        metrics.increment('realtime_stale_connection');
        socket.terminate();
        continue;
      }
      try {
        await options.auth.service.authenticate(state.token);
      } catch {
        safeSend(socket, state, {
          version: 1,
          type: 'error',
          error: 'unauthenticated',
        });
        socket.close(1008, 'unauthenticated');
        continue;
      }
      for (const spaceId of [...state.subscriptions]) {
        try {
          await service.authorizeSpaceSubscription(spaceId, state.actorId);
        } catch {
          removeSubscription(socket, state, spaceId);
          metrics.increment('realtime_subscription_changed', {
            reason: 'revalidated',
          });
          safeSend(socket, state, {
            version: 1,
            type: 'error',
            error: 'unavailable',
          });
        }
      }
    }
    reportConnections();
  }

  const heartbeat = setInterval(() => {
    for (const socket of connections.keys())
      if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, limits.heartbeatMs);
  heartbeat.unref();
  const authorizationCheck = setInterval(
    () => void revalidate(),
    limits.revalidateMs,
  );
  authorizationCheck.unref();
  reportConnections();
  reportOutboundQueue();

  async function startSubscription(
    channel: string,
    listener: (payload: string) => void,
    degradedMetric: string,
    assign: (unsubscribe: () => Promise<void>) => void,
    fanout = false,
  ): Promise<void> {
    if (!options.coordination) return;
    try {
      const unsubscribe = await options.coordination.subscribe(
        channel,
        listener,
      );
      if (draining) await unsubscribe();
      else {
        assign(unsubscribe);
        if (fanout) {
          fanoutSubscribed = true;
          fanoutState = 'ready';
        }
      }
    } catch {
      if (fanout) {
        fanoutSubscribed = false;
        fanoutState = 'degraded';
      }
      metrics.increment(degradedMetric);
    }
  }

  const subscriptionsReady = Promise.all([
    startSubscription(
      'realtime:events',
      (payload) => void receiveFanout(payload),
      'realtime_fanout_degraded',
      (unsubscribe) => {
        unsubscribeFanout = unsubscribe;
      },
      true,
    ),
    ...(options.presence
      ? [
          startSubscription(
            PRESENCE_CHANNEL,
            (payload) => void receivePresence(payload),
            'presence_fanout_degraded',
            (unsubscribe) => {
              unsubscribePresence = unsubscribe;
            },
          ),
        ]
      : []),
    ...(options.memberStatus
      ? [
          startSubscription(
            MEMBER_STATUS_CHANNEL,
            (payload) => void receiveMemberStatus(payload),
            'member_status_fanout_degraded',
            (unsubscribe) => {
              unsubscribeMemberStatus = unsubscribe;
            },
          ),
        ]
      : []),
  ]).then(() => undefined);

  async function receivePresence(payload: string): Promise<void> {
    try {
      if (!options.presence) throw new Error('presence_unavailable');
      const presence = parsePresence(payload);
      for (const [socket, state] of connections) {
        if (!state.presenceSubscriptions.has(presence.accountId)) continue;
        safeSend(socket, state, {
          version: 1,
          type: 'presence',
          presence: {
            accountId: presence.accountId,
            state: await options.presence.view(
              state.actorId,
              presence.accountId,
              new Date(),
            ),
          },
        });
      }
    } catch {
      metrics.increment('presence_fanout_invalid');
    }
  }

  async function receiveMemberStatus(payload: string): Promise<void> {
    try {
      if (!options.memberStatus) throw new Error('member_status_unavailable');
      const event = JSON.parse(payload) as Record<string, unknown>;
      if (
        typeof event.accountId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(event.accountId) ||
        typeof event.version !== 'number' ||
        !Number.isSafeInteger(event.version) ||
        typeof event.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(event.updatedAt))
      )
        throw new Error('invalid_member_status_event');
      for (const [socket, state] of connections) {
        if (!state.presenceSubscriptions.has(event.accountId)) continue;
        safeSend(socket, state, {
          version: 1,
          type: 'member_status',
          accountId: event.accountId,
          status: await options.memberStatus.view(
            state.actorId,
            event.accountId,
            new Date(),
          ),
        });
      }
    } catch {
      metrics.increment('member_status_fanout_invalid');
    }
  }

  function remember(eventId: string): boolean {
    if (seenEvents.has(eventId)) {
      metrics.increment('realtime_event_duplicate');
      return false;
    }
    seenEvents.add(eventId);
    if (seenEvents.size > 10_000) {
      const oldest = seenEvents.values().next().value;
      if (oldest) seenEvents.delete(oldest);
    }
    return true;
  }

  function deliver(spaceId: string, event: RealtimeEnvelope): void {
    if (!remember(event.id)) return;
    const startedAt = Date.now();
    const sequence = (sequences.get(spaceId) ?? 0) + 1;
    sequences.delete(spaceId);
    sequences.set(spaceId, sequence);
    if (sequences.size > maxSequenceStates) {
      let removed = false;
      for (const candidate of sequences.keys()) {
        if (subscribersBySpace.has(candidate)) continue;
        sequences.delete(candidate);
        removed = true;
        break;
      }
      if (!removed) {
        const oldest = sequences.keys().next().value;
        if (oldest !== undefined) sequences.delete(oldest);
      }
    }
    const delivery = realtimeDeliverySchema.parse({
      version: 1,
      type: 'event',
      spaceId,
      sequence,
      event,
    });
    const serialized = serializeValidated(delivery, 'event');
    let delivered = false;
    for (const socket of subscribersBySpace.get(spaceId) ?? []) {
      const state = connections.get(socket);
      if (state && sendSerialized(socket, state, serialized)) {
        delivered = true;
        metrics.increment('realtime_delivery');
      }
    }
    metrics.observe?.('realtime_delivery_duration_ms', Date.now() - startedAt, {
      outcome: delivered ? 'success' : 'no_subscriber',
    });
  }

  async function receiveFanout(payload: string): Promise<void> {
    try {
      const parsed = JSON.parse(payload) as {
        instanceId?: unknown;
        spaceId?: unknown;
        accountId?: unknown;
        message?: unknown;
        event?: unknown;
      };
      if (parsed.instanceId === instanceId) return;
      if (typeof parsed.accountId === 'string') {
        const message = websocketServerMessageSchema.parse(parsed.message);
        if (message.type !== 'notification_read') return;
        if (!remember(message.state.eventId)) return;
        const serialized = serializeValidated(message, 'account');
        for (const [socket, state] of connections) {
          if (state.actorId !== parsed.accountId) continue;
          try {
            await options.auth.service.authenticate(state.token);
            sendSerialized(socket, state, serialized);
          } catch {
            socket.close(1008, 'unauthenticated');
          }
        }
        return;
      }
      if (typeof parsed.spaceId !== 'string') return;
      const event = realtimeEnvelopeSchema.parse(parsed.event);
      if (seenEvents.has(event.id)) return;
      // Revalidate each local subscriber before cross-instance disclosure.
      let removed = false;
      for (const socket of [
        ...(subscribersBySpace.get(parsed.spaceId) ?? []),
      ]) {
        const state = connections.get(socket);
        if (!state) continue;
        try {
          await service.authorizeSpaceSubscription(
            parsed.spaceId,
            state.actorId,
          );
        } catch {
          removed =
            removeSubscription(socket, state, parsed.spaceId) || removed;
        }
      }
      if (removed) reportConnections();
      deliver(parsed.spaceId, event);
    } catch {
      metrics.increment('realtime_fanout_invalid');
    }
  }

  function publishFanout(payload: string): void {
    if (!options.coordination) return;
    void options.coordination.publish('realtime:events', payload).then(
      () => {
        fanoutState = fanoutSubscribed ? 'ready' : 'degraded';
      },
      () => {
        fanoutState = 'degraded';
        metrics.increment('realtime_fanout_degraded');
      },
    );
  }

  return {
    ready: () => subscriptionsReady,
    broadcast(spaceId, rawEvent) {
      const event = realtimeEnvelopeSchema.parse(rawEvent);
      deliver(spaceId, event);
      publishFanout(JSON.stringify({ instanceId, spaceId, event }));
    },
    broadcastAccount(accountId, rawMessage) {
      const message = websocketServerMessageSchema.parse(rawMessage);
      if (message.type !== 'notification_read') return;
      if (!remember(message.state.eventId)) return;
      const serialized = serializeValidated(message, 'account');
      for (const [socket, state] of connections)
        if (state.actorId === accountId)
          sendSerialized(socket, state, serialized);
      publishFanout(JSON.stringify({ instanceId, accountId, message }));
    },
    async close() {
      if (draining) return;
      draining = true;
      clearInterval(heartbeat);
      clearInterval(authorizationCheck);
      for (const state of pending.values()) clearTimeout(state.timeout);
      pending.clear();
      await subscriptionsReady;
      await unsubscribeFanout?.();
      await unsubscribePresence?.();
      await unsubscribeMemberStatus?.();
      for (const [socket, state] of connections) {
        safeSend(socket, state, {
          version: 1,
          type: 'error',
          error: 'server_draining',
        });
        socket.close(1001, 'server shutdown');
      }
      const deadline = setTimeout(() => {
        for (const socket of connections.keys()) socket.terminate();
      }, limits.drainMs);
      deadline.unref();
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      clearTimeout(deadline);
      connections.clear();
      subscribersBySpace.clear();
      subscriptionCount = 0;
      reportConnections();
    },
    snapshot() {
      return {
        connections: connections.size,
        subscriptions: subscriptionCount,
      };
    },
    capacitySnapshot() {
      return {
        connections: connections.size,
        subscriptions: subscriptionCount,
        queueDepth: queuedMessages,
        queueBytes: queuedBytes,
        fanout: fanoutState,
      };
    },
  };
}

function enforceRateLimit(decision: RateLimitDecision): void {
  if (!decision.allowed)
    throw new AdmissionError(
      decision.reason ?? 'rate_limited',
      decision.reason === 'dependency_unavailable' ? 503 : 429,
      decision,
    );
}

function rateLimitHeaders(decision: RateLimitDecision) {
  return {
    'RateLimit-Limit': String(decision.limit),
    'RateLimit-Remaining': String(decision.remaining),
    'RateLimit-Reset': String(decision.retryAfterSeconds),
    'Retry-After': String(decision.retryAfterSeconds),
  };
}

function closeOutcome(code: number): string {
  if (code === 1000) return 'normal';
  if (code === 1001) return 'shutdown';
  if (code === 1007 || code === 1008 || code === 1013) return 'policy';
  return 'internal';
}
