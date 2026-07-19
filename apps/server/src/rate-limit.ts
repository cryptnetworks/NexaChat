import { createHash } from 'node:crypto';
import type { EphemeralCoordination } from '@nexa/coordination';

export type RateLimitEndpoint =
  | 'account'
  | 'administration'
  | 'api_token'
  | 'authentication'
  | 'community'
  | 'invitation'
  | 'read'
  | 'session'
  | 'webhook'
  | 'websocket'
  | 'write'
  | 'other';
export type RateLimitScope = 'account' | 'address' | 'community' | 'route';
export type RateLimitTrust = 'authenticated' | 'development' | 'public';
export type RateLimitBackend = 'local' | 'shared';

export interface RequestRateLimitConfig {
  addressLimit: number;
  accountLimit: number;
  windowMs: number;
  localBucketLimit?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  backend: RateLimitBackend;
  degraded: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  reason?: 'dependency_unavailable' | 'rate_limited';
}

export class RequestRateLimitError extends Error {
  constructor(readonly decision: RateLimitDecision) {
    super(decision.reason ?? 'rate_limited');
    this.name = 'RequestRateLimitError';
  }
}

export interface RateLimitObserver {
  decision(
    scope: RateLimitScope,
    endpoint: RateLimitEndpoint,
    outcome: 'allowed' | 'degraded' | 'dependency_failure' | 'limited',
    backend: RateLimitBackend,
  ): void;
}

export interface RequestRateLimiter {
  consumeRoute(input: {
    method: string;
    route: string;
  }): Promise<RateLimitDecision>;
  consumeAddress(input: {
    method: string;
    route: string;
    address: string;
  }): Promise<RateLimitDecision>;
  consumeAccount(input: {
    method: string;
    route: string;
    accountId: string;
    trust: Exclude<RateLimitTrust, 'public'>;
  }): Promise<RateLimitDecision>;
  consumeCommunity(input: {
    method: string;
    route: string;
    communityId: string;
  }): Promise<RateLimitDecision>;
}

interface LocalBucket {
  count: number;
  expiresAt: number;
}

export class DistributedRequestRateLimiter implements RequestRateLimiter {
  private readonly local = new Map<string, LocalBucket>();
  private readonly ttlSeconds: number;
  private readonly localBucketLimit: number;

  constructor(
    private readonly config: RequestRateLimitConfig,
    private readonly coordination?: EphemeralCoordination,
    private readonly observer?: RateLimitObserver,
    private readonly clock: () => number = Date.now,
  ) {
    if (
      !Number.isSafeInteger(config.addressLimit) ||
      config.addressLimit < 1 ||
      !Number.isSafeInteger(config.accountLimit) ||
      config.accountLimit < 1 ||
      !Number.isSafeInteger(config.windowMs) ||
      config.windowMs < 1
    )
      throw new Error('invalid_rate_limit_configuration');
    this.ttlSeconds = Math.max(1, Math.ceil(config.windowMs / 1_000));
    this.localBucketLimit = config.localBucketLimit ?? 10_000;
    if (
      !Number.isSafeInteger(this.localBucketLimit) ||
      this.localBucketLimit < 1
    )
      throw new Error('invalid_rate_limit_configuration');
  }

  consumeAddress(input: {
    method: string;
    route: string;
    address: string;
  }): Promise<RateLimitDecision> {
    const endpoint = endpointFor(input.method, input.route);
    return this.consume({
      endpoint,
      scope: 'address',
      trust: 'public',
      identity: input.address,
      limit: addressLimit(endpoint, this.config.addressLimit),
    });
  }

  consumeRoute(input: {
    method: string;
    route: string;
  }): Promise<RateLimitDecision> {
    const endpoint = endpointFor(input.method, input.route);
    return this.consume({
      endpoint,
      scope: 'route',
      trust: 'public',
      identity: endpoint,
      limit: multipliedLimit(
        routeLimit(endpoint, this.config.addressLimit),
        100,
      ),
    });
  }

  consumeAccount(input: {
    method: string;
    route: string;
    accountId: string;
    trust: Exclude<RateLimitTrust, 'public'>;
  }): Promise<RateLimitDecision> {
    const endpoint = endpointFor(input.method, input.route);
    return this.consume({
      endpoint,
      scope: 'account',
      trust: input.trust,
      identity: input.accountId,
      limit: accountLimit(endpoint, this.config.accountLimit),
    });
  }

  consumeCommunity(input: {
    method: string;
    route: string;
    communityId: string;
  }): Promise<RateLimitDecision> {
    const endpoint = endpointFor(input.method, input.route);
    return this.consume({
      endpoint,
      scope: 'community',
      trust: 'public',
      identity: input.communityId,
      limit: multipliedLimit(
        accountLimit(endpoint, this.config.accountLimit),
        10,
      ),
    });
  }

  private async consume(input: {
    endpoint: RateLimitEndpoint;
    scope: RateLimitScope;
    trust: RateLimitTrust;
    identity: string;
    limit: number;
  }): Promise<RateLimitDecision> {
    const key = keyFor(input);
    if (!this.coordination) {
      const decision = this.consumeLocal(key, input.limit, false);
      this.report(input, decision);
      return decision;
    }
    try {
      const counter = await this.coordination.increment(key, this.ttlSeconds);
      const decision = decisionFor(
        counter.count,
        input.limit,
        counter.ttlSeconds,
        'shared',
        false,
      );
      this.report(input, decision);
      return decision;
    } catch {
      if (isSensitive(input.endpoint)) {
        const decision: RateLimitDecision = {
          allowed: false,
          backend: 'shared',
          degraded: true,
          limit: input.limit,
          remaining: 0,
          retryAfterSeconds: Math.min(5, this.ttlSeconds),
          reason: 'dependency_unavailable',
        };
        this.report(input, decision);
        return decision;
      }
      const decision = this.consumeLocal(key, input.limit, true);
      this.report(input, decision);
      return decision;
    }
  }

  private consumeLocal(
    key: string,
    limit: number,
    degraded: boolean,
  ): RateLimitDecision {
    const now = this.clock();
    const current = this.local.get(key);
    const bucket =
      !current || current.expiresAt <= now
        ? { count: 0, expiresAt: now + this.config.windowMs }
        : current;
    bucket.count += 1;
    this.local.delete(key);
    this.local.set(key, bucket);
    while (this.local.size > this.localBucketLimit) {
      const oldest = this.local.keys().next().value;
      if (oldest === undefined) break;
      this.local.delete(oldest);
    }
    return decisionFor(
      bucket.count,
      limit,
      Math.max(1, Math.ceil((bucket.expiresAt - now) / 1_000)),
      'local',
      degraded,
    );
  }

  private report(
    input: {
      endpoint: RateLimitEndpoint;
      scope: RateLimitScope;
    },
    decision: RateLimitDecision,
  ): void {
    try {
      this.observer?.decision(
        input.scope,
        input.endpoint,
        decision.reason === 'dependency_unavailable'
          ? 'dependency_failure'
          : !decision.allowed
            ? 'limited'
            : decision.degraded
              ? 'degraded'
              : 'allowed',
        decision.backend,
      );
    } catch {
      // Observability cannot change admission behavior.
    }
  }
}

export function endpointFor(method: string, route: string): RateLimitEndpoint {
  const path = route.split('?', 1)[0]?.toLowerCase() ?? '';
  if (path === '/v1/realtime' || path.startsWith('/v1/realtime/'))
    return 'websocket';
  if (path === '/v1/sessions' || path.startsWith('/v1/sessions/'))
    return 'session';
  if (path === '/v1/account' || path.startsWith('/v1/account/'))
    return 'account';
  if (path.startsWith('/v1/api-tokens')) return 'api_token';
  if (path.startsWith('/v1/webhooks')) return 'webhook';
  if (path.startsWith('/v1/admin')) return 'administration';
  if (path.startsWith('/v1/auth/')) return 'authentication';
  if (path.includes('/invitations')) return 'invitation';
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return 'read';
  if (['DELETE', 'PATCH', 'POST', 'PUT'].includes(verb)) return 'write';
  return 'other';
}

export function communityIdentityFor(url: string): string | undefined {
  const path = url.split('?', 1)[0] ?? '';
  const match = /^\/v1\/communities\/([^/]+)/i.exec(path);
  const value = match?.[1]?.toLowerCase();
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
    ? value
    : undefined;
}

function keyFor(input: {
  endpoint: RateLimitEndpoint;
  scope: RateLimitScope;
  trust: RateLimitTrust;
  identity: string;
}): string {
  const digest = createHash('sha256')
    .update('nexa-rate-limit\0')
    .update(input.scope)
    .update('\0')
    .update(input.trust)
    .update('\0')
    .update(input.identity)
    .digest('hex');
  return `rate:${input.scope}:${input.endpoint}:${input.trust}:${digest}`;
}

function addressLimit(endpoint: RateLimitEndpoint, base: number): number {
  if (endpoint === 'administration') return Math.min(base, 30);
  if (endpoint === 'api_token') return Math.min(base, 30);
  if (endpoint === 'authentication') return Math.min(base, 20);
  if (endpoint === 'invitation') return Math.min(base, 60);
  if (endpoint === 'session') return Math.min(base, 60);
  if (endpoint === 'webhook') return Math.min(base, 120);
  if (endpoint === 'websocket') return Math.min(base, 60);
  if (endpoint === 'write') return Math.min(base, 300);
  return base;
}

function accountLimit(endpoint: RateLimitEndpoint, base: number): number {
  if (endpoint === 'administration') return Math.min(base, 60);
  if (endpoint === 'api_token') return Math.min(base, 60);
  if (endpoint === 'session') return Math.min(base, 120);
  if (endpoint === 'webhook') return Math.min(base, 300);
  if (endpoint === 'websocket') return Math.min(base, 120);
  if (endpoint === 'invitation') return Math.min(base, 120);
  if (endpoint === 'write') return Math.min(base, 600);
  return base;
}

function isSensitive(endpoint: RateLimitEndpoint): boolean {
  return [
    'administration',
    'api_token',
    'authentication',
    'invitation',
    'session',
    'webhook',
    'websocket',
  ].includes(endpoint);
}

function routeLimit(endpoint: RateLimitEndpoint, base: number): number {
  return endpoint === 'authentication' || endpoint === 'invitation'
    ? addressLimit(endpoint, base)
    : accountLimit(endpoint, base);
}

function multipliedLimit(limit: number, multiplier: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, limit * multiplier);
}

function decisionFor(
  count: number,
  limit: number,
  retryAfterSeconds: number,
  backend: RateLimitBackend,
  degraded: boolean,
): RateLimitDecision {
  const allowed = count <= limit;
  return {
    allowed,
    backend,
    degraded,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds,
    ...(allowed ? {} : { reason: 'rate_limited' as const }),
  };
}
