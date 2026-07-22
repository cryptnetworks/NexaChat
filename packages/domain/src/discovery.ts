export interface DiscoverableMember {
  accountId: string;
  communityId: string;
  displayName: string;
  normalizedIdentifier: string;
  membershipStatus: 'active' | 'suspended' | 'left' | 'removed';
}

export interface DiscoverableSpace {
  id: string;
  communityId: string;
  name: string;
  normalizedName: string;
  archivedAt: string | null;
}

export interface DiscoveryCandidate {
  id: string;
  rank: number;
  normalizedName: string;
}

export interface DiscoveryPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface DiscoveryStore {
  memberCandidates(input: {
    communityId: string;
    query: string;
    after?: DiscoveryCandidate;
    limit: number;
  }): Promise<DiscoveryCandidate[]>;
  spaceCandidates(input: {
    communityId: string;
    query: string;
    after?: DiscoveryCandidate;
    limit: number;
  }): Promise<DiscoveryCandidate[]>;
  member(
    communityId: string,
    accountId: string,
  ): Promise<DiscoverableMember | undefined>;
  space(id: string): Promise<DiscoverableSpace | undefined>;
}

export interface DiscoveryAuthorization {
  assertCommunityVisible(actorId: string, communityId: string): Promise<void>;
  assertMemberVisible(
    actorId: string,
    member: DiscoverableMember,
  ): Promise<void>;
  assertSpaceVisible(actorId: string, space: DiscoverableSpace): Promise<void>;
  isBlocked(actorId: string, targetId: string): Promise<boolean>;
}

export interface DiscoveryRateLimiter {
  consume(key: string, now: Date): Promise<boolean>;
}

export function normalizeDiscoveryIdentifier(value: string): string {
  const normalized = value
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFKC')
    .toLocaleLowerCase();
  if (normalized.length < 2 || normalized.length > 64)
    throw new Error('invalid_discovery_query');
  return normalized;
}

function parseCursor(value?: string): DiscoveryCandidate | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString(),
    ) as Record<string, unknown>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.rank !== 'number' ||
      !Number.isFinite(parsed.rank) ||
      typeof parsed.normalizedName !== 'string'
    )
      throw new Error('bad');
    return {
      id: parsed.id,
      rank: parsed.rank,
      normalizedName: parsed.normalizedName,
    };
  } catch {
    throw new Error('invalid_discovery_cursor');
  }
}

const encodeCursor = (candidate: DiscoveryCandidate): string =>
  Buffer.from(JSON.stringify(candidate)).toString('base64url');

export class DiscoveryService {
  constructor(
    private readonly store: DiscoveryStore,
    private readonly authorization: DiscoveryAuthorization,
    private readonly limiter: DiscoveryRateLimiter,
  ) {}

  async members(input: {
    actorId: string;
    communityId: string;
    query: string;
    limit: number;
    cursor?: string;
    now: Date;
  }): Promise<DiscoveryPage<DiscoverableMember>> {
    const query = normalizeDiscoveryIdentifier(input.query);
    this.validateLimit(input.limit);
    await this.authorizeAndLimit(input.actorId, input.communityId, input.now);
    const after = parseCursor(input.cursor);
    const candidates = await this.store.memberCandidates({
      communityId: input.communityId,
      query,
      ...(after ? { after } : {}),
      limit: Math.min(100, input.limit * 4),
    });
    const items: DiscoverableMember[] = [];
    let last: DiscoveryCandidate | undefined;
    for (const candidate of candidates) {
      last = candidate;
      const member = await this.store.member(input.communityId, candidate.id);
      if (
        !member ||
        member.membershipStatus !== 'active' ||
        (await this.authorization.isBlocked(input.actorId, member.accountId))
      )
        continue;
      try {
        await this.authorization.assertMemberVisible(input.actorId, member);
      } catch {
        continue;
      }
      items.push(member);
      if (items.length === input.limit) break;
    }
    return this.page(items, candidates, last, input.limit);
  }

  async spaces(input: {
    actorId: string;
    communityId: string;
    query: string;
    limit: number;
    cursor?: string;
    now: Date;
  }): Promise<DiscoveryPage<DiscoverableSpace>> {
    const query = normalizeDiscoveryIdentifier(input.query);
    this.validateLimit(input.limit);
    await this.authorizeAndLimit(input.actorId, input.communityId, input.now);
    const after = parseCursor(input.cursor);
    const candidates = await this.store.spaceCandidates({
      communityId: input.communityId,
      query,
      ...(after ? { after } : {}),
      limit: Math.min(100, input.limit * 4),
    });
    const items: DiscoverableSpace[] = [];
    let last: DiscoveryCandidate | undefined;
    for (const candidate of candidates) {
      last = candidate;
      const space = await this.store.space(candidate.id);
      if (!space || space.communityId !== input.communityId || space.archivedAt)
        continue;
      try {
        await this.authorization.assertSpaceVisible(input.actorId, space);
      } catch {
        continue;
      }
      items.push(space);
      if (items.length === input.limit) break;
    }
    return this.page(items, candidates, last, input.limit);
  }

  private page<T>(
    items: T[],
    candidates: DiscoveryCandidate[],
    last: DiscoveryCandidate | undefined,
    limit: number,
  ): DiscoveryPage<T> {
    return {
      items,
      nextCursor:
        candidates.length === Math.min(100, limit * 4) && last
          ? encodeCursor(last)
          : null,
    };
  }

  private validateLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25)
      throw new Error('invalid_discovery_page');
  }

  private async authorizeAndLimit(
    actorId: string,
    communityId: string,
    now: Date,
  ): Promise<void> {
    try {
      await this.authorization.assertCommunityVisible(actorId, communityId);
    } catch {
      throw new Error('discovery_unavailable');
    }
    if (!(await this.limiter.consume(`${actorId}:${communityId}`, now)))
      throw new Error('discovery_rate_limited');
  }
}

export class FixedWindowDiscoveryLimiter implements DiscoveryRateLimiter {
  private readonly buckets = new Map<
    string,
    { count: number; start: number }
  >();
  constructor(
    private readonly limit = 30,
    private readonly windowMs = 60_000,
  ) {}
  consume(key: string, now: Date): Promise<boolean> {
    const timestamp = now.getTime();
    const current = this.buckets.get(key);
    const bucket =
      !current || timestamp - current.start >= this.windowMs
        ? { count: 0, start: timestamp }
        : current;
    if (bucket.count >= this.limit) return Promise.resolve(false);
    this.buckets.set(key, { ...bucket, count: bucket.count + 1 });
    if (this.buckets.size > 10_000)
      this.buckets.delete(this.buckets.keys().next().value ?? '');
    return Promise.resolve(true);
  }
}
