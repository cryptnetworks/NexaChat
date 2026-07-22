import type { IncomingMessage, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  websocketClientMessageSchema,
  websocketServerMessageSchema,
  type WebsocketServerMessage,
} from '@nexa/api-contracts';
import { AuthenticationError, type AuthenticatedSession } from '@nexa/auth';
import type { CommunityService } from '@nexa/domain';
import {
  realtimeDeliverySchema,
  realtimeEnvelopeSchema,
  type RealtimeDelivery,
  type RealtimeEnvelope,
} from '@nexa/realtime-contracts';
import { sessionTokenFromCookie, type AuthRuntime } from './auth-routes.js';
import type { EphemeralCoordination } from '@nexa/coordination';

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
}

export interface WebsocketHubOptions {
  auth: AuthRuntime;
  trustedOrigin: string;
  limits?: Partial<WebsocketLimits>;
  metrics?: WebsocketMetrics;
  coordination?: EphemeralCoordination;
  instanceId?: string;
}

export interface WebsocketHub {
  broadcast(spaceId: string, event: RealtimeEnvelope): void;
  broadcastAccount(
    accountId: string,
    message: Extract<WebsocketServerMessage, { type: 'notification_read' }>,
  ): void;
  close(): Promise<void>;
  snapshot?(): { connections: number; subscriptions: number };
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
  lastSeenAt: number;
  rateStartedAt: number;
  messagesInWindow: number;
  outboundBytes: number;
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
  const metrics = options.metrics ?? noopMetrics;
  const pending = new Map<
    IncomingMessage,
    AuthenticatedSession & { token: string }
  >();
  const connections = new Map<WebSocket, ConnectionState>();
  const sequences = new Map<string, number>();
  const seenEvents = new Set<string>();
  const instanceId = options.instanceId ?? randomUUID();
  let unsubscribeFanout: (() => Promise<void>) | undefined;
  let draining = false;
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
          const status = error instanceof AuthenticationError ? 401 : 403;
          metrics.increment('realtime_connection_rejected', {
            reason: status === 401 ? 'unauthenticated' : 'origin',
          });
          callback(
            false,
            status,
            status === 401 ? 'Unauthorized' : 'Forbidden',
          );
        },
      );
    },
  });

  async function verify(
    request: IncomingMessage,
    origin: string,
  ): Promise<void> {
    if (draining || origin !== options.trustedOrigin) throw new Error('reject');
    const address = request.socket.remoteAddress ?? 'unknown';
    if (
      connections.size >= limits.maxConnections ||
      countConnections((state) => state.address === address) >=
        limits.maxConnectionsPerAddress
    )
      throw new Error('reject');
    const token = sessionTokenFromCookie(
      request.headers.cookie,
      options.auth.config.secureCookies,
    );
    if (!token) throw new AuthenticationError('unauthenticated');
    const authenticated = await options.auth.service.authenticate(token);
    if (
      countConnections((state) => state.actorId === authenticated.account.id) >=
      limits.maxConnectionsPerAccount
    )
      throw new Error('reject');
    pending.set(request, { ...authenticated, token });
  }

  function countConnections(predicate: (state: ConnectionState) => boolean) {
    let count = 0;
    for (const state of connections.values()) if (predicate(state)) count += 1;
    return count;
  }

  wss.on('connection', (socket, request) => {
    const authenticated = pending.get(request);
    pending.delete(request);
    if (!authenticated) {
      socket.close(1008, 'unauthenticated');
      return;
    }
    const now = Date.now();
    const state: ConnectionState = {
      actorId: authenticated.account.id,
      token: authenticated.token,
      address: request.socket.remoteAddress ?? 'unknown',
      subscriptions: new Set(),
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
      cleanup(socket);
    });
    socket.on('close', () => {
      cleanup(socket);
    });
  });

  function cleanup(socket: WebSocket): void {
    if (!connections.delete(socket)) return;
    metrics.increment('realtime_connection_closed');
    reportConnections();
  }

  function reportConnections(): void {
    metrics.gauge('realtime_connections', connections.size);
    metrics.gauge(
      'realtime_subscriptions',
      [...connections.values()].reduce(
        (total, state) => total + state.subscriptions.size,
        0,
      ),
    );
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
    if (parsed.data.type === 'unsubscribe') {
      state.subscriptions.delete(parsed.data.spaceId);
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
      state.subscriptions.add(parsed.data.spaceId);
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
    if (socket.readyState !== WebSocket.OPEN) return false;
    const payload = JSON.stringify(
      websocketServerMessageSchema.or(realtimeDeliverySchema).parse(message),
    );
    const bytes = Buffer.byteLength(payload);
    if (
      socket.bufferedAmount + state.outboundBytes + bytes >
      limits.maxBufferedBytes
    ) {
      metrics.increment('realtime_slow_consumer');
      socket.close(1013, 'slow consumer');
      return false;
    }
    state.outboundBytes += bytes;
    socket.send(payload, (error) => {
      state.outboundBytes = Math.max(0, state.outboundBytes - bytes);
      if (error) socket.terminate();
    });
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
        socket.close(1008, 'unauthenticated');
        continue;
      }
      for (const spaceId of [...state.subscriptions]) {
        try {
          await service.authorizeSpaceSubscription(spaceId, state.actorId);
        } catch {
          state.subscriptions.delete(spaceId);
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

  if (options.coordination)
    void options.coordination
      .subscribe('realtime:events', (payload) => {
        void receiveFanout(payload);
      })
      .then((unsubscribe) => {
        unsubscribeFanout = unsubscribe;
      })
      .catch(() => {
        metrics.increment('realtime_fanout_degraded');
      });

  function remember(eventId: string): boolean {
    if (seenEvents.has(eventId)) return false;
    seenEvents.add(eventId);
    if (seenEvents.size > 10_000) {
      const oldest = seenEvents.values().next().value;
      if (oldest) seenEvents.delete(oldest);
    }
    return true;
  }

  function deliver(spaceId: string, event: RealtimeEnvelope): void {
    if (!remember(event.id)) return;
    const sequence = (sequences.get(spaceId) ?? 0) + 1;
    sequences.set(spaceId, sequence);
    const delivery = realtimeDeliverySchema.parse({
      version: 1,
      type: 'event',
      spaceId,
      sequence,
      event,
    });
    for (const [socket, state] of connections)
      if (state.subscriptions.has(spaceId)) safeSend(socket, state, delivery);
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
        for (const [socket, state] of connections) {
          if (state.actorId !== parsed.accountId) continue;
          try {
            await options.auth.service.authenticate(state.token);
            safeSend(socket, state, message);
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
      for (const state of connections.values()) {
        if (!state.subscriptions.has(parsed.spaceId)) continue;
        try {
          await service.authorizeSpaceSubscription(
            parsed.spaceId,
            state.actorId,
          );
        } catch {
          state.subscriptions.delete(parsed.spaceId);
        }
      }
      deliver(parsed.spaceId, event);
    } catch {
      metrics.increment('realtime_fanout_invalid');
    }
  }

  return {
    broadcast(spaceId, rawEvent) {
      const event = realtimeEnvelopeSchema.parse(rawEvent);
      deliver(spaceId, event);
      if (options.coordination)
        void options.coordination
          .publish(
            'realtime:events',
            JSON.stringify({ instanceId, spaceId, event }),
          )
          .catch(() => {
            metrics.increment('realtime_fanout_degraded');
          });
    },
    broadcastAccount(accountId, rawMessage) {
      const message = websocketServerMessageSchema.parse(rawMessage);
      if (message.type !== 'notification_read') return;
      if (!remember(message.state.eventId)) return;
      for (const [socket, state] of connections)
        if (state.actorId === accountId) safeSend(socket, state, message);
      if (options.coordination)
        void options.coordination
          .publish(
            'realtime:events',
            JSON.stringify({ instanceId, accountId, message }),
          )
          .catch(() => {
            metrics.increment('realtime_fanout_degraded');
          });
    },
    async close() {
      if (draining) return;
      draining = true;
      clearInterval(heartbeat);
      clearInterval(authorizationCheck);
      await unsubscribeFanout?.();
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
      reportConnections();
    },
    snapshot() {
      return {
        connections: connections.size,
        subscriptions: [...connections.values()].reduce(
          (total, state) => total + state.subscriptions.size,
          0,
        ),
      };
    },
  };
}
