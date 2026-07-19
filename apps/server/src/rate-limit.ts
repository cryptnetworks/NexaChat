import { createHash } from 'node:crypto';
import type { EphemeralCoordination } from '@nexa/coordination';

export type RateLimitEndpoint =
  'authentication' | 'invitation' | 'read' | 'write' | 'other';
export type RateLimitScope = 'account' | 'address';
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
  const path = route.split('?', 1)[0] ?? '';
  if (path.startsWith('/v1/auth/')) return 'authentication';
  if (path.includes('/invitations')) return 'invitation';
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (['DELETE', 'PATCH', 'POST', 'PUT'].includes(method)) return 'write';
  return 'other';
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
  if (endpoint === 'authentication') return Math.min(base, 20);
  if (endpoint === 'invitation') return Math.min(base, 60);
  if (endpoint === 'write') return Math.min(base, 300);
  return base;
}

function accountLimit(endpoint: RateLimitEndpoint, base: number): number {
  if (endpoint === 'invitation') return Math.min(base, 120);
  if (endpoint === 'write') return Math.min(base, 600);
  return base;
}

function isSensitive(endpoint: RateLimitEndpoint): boolean {
  return endpoint === 'authentication' || endpoint === 'invitation';
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
