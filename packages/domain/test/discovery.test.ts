import { describe, expect, it } from 'vitest';
import {
  DiscoveryService,
  FixedWindowDiscoveryLimiter,
  normalizeDiscoveryIdentifier,
  type DiscoverableMember,
  type DiscoverableSpace,
  type DiscoveryCandidate,
} from '../src/discovery.js';

const member = (
  id: string,
  status: DiscoverableMember['membershipStatus'] = 'active',
): DiscoverableMember => ({
  accountId: id,
  communityId: 'c',
  displayName: id,
  normalizedIdentifier: id.toLowerCase(),
  membershipStatus: status,
});
const space = (
  id: string,
  archivedAt: string | null = null,
): DiscoverableSpace => ({
  id,
  communityId: 'c',
  name: id,
  normalizedName: id.toLowerCase(),
  archivedAt,
});

describe('member and space discovery', () => {
  it('normalizes identifiers and rejects enumeration-shaped queries', () => {
    expect(normalizeDiscoveryIdentifier('  ÄLICE  SMITH ')).toBe('älice smith');
    expect(() => normalizeDiscoveryIdentifier('a')).toThrow(
      'invalid_discovery_query',
    );
  });

  it('filters blocked, suspended, hidden, archived, and stale candidates', async () => {
    const members = new Map([
      ['alice', member('alice')],
      ['blocked', member('blocked')],
      ['suspended', member('suspended', 'suspended')],
    ]);
    const spaces = new Map([
      ['general', space('general')],
      ['hidden', space('hidden')],
      ['archive', space('archive', '2026-01-01')],
    ]);
    const candidates = (ids: string[]): DiscoveryCandidate[] =>
      ids.map((id, rank) => ({ id, rank: 10 - rank, normalizedName: id }));
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const service = new DiscoveryService(
      {
        memberCandidates: async () =>
          candidates(['alice', 'blocked', 'suspended', 'missing']),
        spaceCandidates: async () =>
          candidates(['general', 'hidden', 'archive', 'missing']),
        member: async (_community, id) => members.get(id),
        space: async (id) => spaces.get(id),
      },
      {
        assertCommunityVisible: async () => {},
        assertMemberVisible: async () => {},
        assertSpaceVisible: async (_actor, value) => {
          if (value.id === 'hidden') throw new Error('hidden');
        },
        isBlocked: async (_actor, target) => target === 'blocked',
      },
      new FixedWindowDiscoveryLimiter(),
    );
    /* eslint-enable @typescript-eslint/require-await */
    const now = new Date('2026-01-01');
    expect(
      (
        await service.members({
          actorId: 'viewer',
          communityId: 'c',
          query: 'al',
          limit: 10,
          now,
        })
      ).items.map((value) => value.accountId),
    ).toEqual(['alice']);
    expect(
      (
        await service.spaces({
          actorId: 'viewer',
          communityId: 'c',
          query: 'ge',
          limit: 10,
          now,
        })
      ).items.map((value) => value.id),
    ).toEqual(['general']);
  });

  it('uses non-disclosing scope failures and bounded anti-enumeration limits', async () => {
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const store = {
      memberCandidates: async () => [],
      spaceCandidates: async () => [],
      member: async () => undefined,
      space: async () => undefined,
    };
    const denied = new DiscoveryService(
      store,
      {
        assertCommunityVisible: async () => {
          throw new Error('denied');
        },
        assertMemberVisible: async () => {},
        assertSpaceVisible: async () => {},
        isBlocked: async () => false,
      },
      new FixedWindowDiscoveryLimiter(),
    );
    /* eslint-enable @typescript-eslint/require-await */
    await expect(
      denied.members({
        actorId: 'u',
        communityId: 'private',
        query: 'ab',
        limit: 10,
        now: new Date(),
      }),
    ).rejects.toThrow('discovery_unavailable');

    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const limited = new DiscoveryService(
      store,
      {
        assertCommunityVisible: async () => {},
        assertMemberVisible: async () => {},
        assertSpaceVisible: async () => {},
        isBlocked: async () => false,
      },
      new FixedWindowDiscoveryLimiter(1),
    );
    /* eslint-enable @typescript-eslint/require-await */
    const input = {
      actorId: 'u',
      communityId: 'c',
      query: 'ab',
      limit: 10,
      now: new Date('2026-01-01'),
    };
    await limited.members(input);
    await expect(limited.members(input)).rejects.toThrow(
      'discovery_rate_limited',
    );
  });

  it('fails closed at bounded limiter capacity and recovers expired buckets', async () => {
    const limiter = new FixedWindowDiscoveryLimiter(2, 1_000, 1);
    const start = new Date('2026-01-01T00:00:00.000Z');
    expect(await limiter.consume('one', start)).toBe(true);
    expect(await limiter.consume('two', start)).toBe(false);
    expect(
      await limiter.consume('two', new Date('2026-01-01T00:00:01.000Z')),
    ).toBe(true);
  });
});
