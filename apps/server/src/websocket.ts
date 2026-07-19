import type { IncomingMessage, Server } from 'node:http';
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
import { createClientAddressResolver } from './client-address.js';
import type { RateLimitDecision, RequestRateLimiter } from './rate-limit.js';

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
}

export interface WebsocketHub {
  broadcast(spaceId: string, event: RealtimeEnvelope): void;
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
  const pending = new Map<
    IncomingMessage,
    AuthenticatedSession & { token: string; address: string }
  >();
  const connections = new Map<WebSocket, ConnectionState>();
  const sequences = new Map<string, number>();
  let outboundQueueBytes = 0;
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
      connections.size >= limits.maxConnections ||
      countConnections((state) => state.address === address) >=
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
    if (
      countConnections((state) => state.actorId === authenticated.account.id) >=
      limits.maxConnectionsPerAccount
    )
      throw new AdmissionError('capacity');
    pending.set(request, { ...authenticated, token, address });
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
      address: authenticated.address,
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
      cleanup(socket, 'internal');
    });
    socket.on('close', (code) => {
      cleanup(socket, closeOutcome(code));
    });
  });

  function cleanup(socket: WebSocket, reason: string): void {
    const state = connections.get(socket);
    if (!state || !connections.delete(socket)) return;
    outboundQueueBytes = Math.max(0, outboundQueueBytes - state.outboundBytes);
    state.outboundBytes = 0;
    metrics.increment('realtime_connection_closed', { reason });
    reportConnections();
    reportOutboundQueue();
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

  function reportOutboundQueue(): void {
    metrics.gauge('realtime_outbound_queue_bytes', outboundQueueBytes);
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
    if (parsed.data.type === 'unsubscribe') {
      state.subscriptions.delete(parsed.data.spaceId);
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
      state.subscriptions.add(parsed.data.spaceId);
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
    outboundQueueBytes += bytes;
    reportOutboundQueue();
    socket.send(payload, (error) => {
      const released = Math.min(bytes, state.outboundBytes);
      state.outboundBytes -= released;
      outboundQueueBytes = Math.max(0, outboundQueueBytes - released);
      reportOutboundQueue();
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
          state.subscriptions.delete(spaceId);
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

  return {
    broadcast(spaceId, rawEvent) {
      const startedAt = Date.now();
      const event = realtimeEnvelopeSchema.parse(rawEvent);
      const sequence = (sequences.get(spaceId) ?? 0) + 1;
      sequences.set(spaceId, sequence);
      const delivery = realtimeDeliverySchema.parse({
        version: 1,
        type: 'event',
        spaceId,
        sequence,
        event,
      });
      let delivered = 0;
      for (const [socket, state] of connections)
        if (
          state.subscriptions.has(spaceId) &&
          safeSend(socket, state, delivery)
        )
          delivered += 1;
      metrics.increment('realtime_delivery', {
        reason: delivered > 0 ? 'success' : 'no_subscriber',
      });
      metrics.observe?.(
        'realtime_delivery_duration_ms',
        Date.now() - startedAt,
        {
          outcome: delivered > 0 ? 'success' : 'no_subscriber',
        },
      );
    },
    async close() {
      if (draining) return;
      draining = true;
      clearInterval(heartbeat);
      clearInterval(authorizationCheck);
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
