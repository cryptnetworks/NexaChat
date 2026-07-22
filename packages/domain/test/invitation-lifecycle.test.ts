import { describe, expect, it } from 'vitest';
import {
  FixedWindowInvitationRateLimiter,
  InMemoryCommunityService,
  InMemoryPersistence,
  protectInvitationToken,
} from '../src/index.js';

const token = 'A'.repeat(43);

describe('controlled invitation lifecycle', () => {
  it('bounds limiter state and recovers expired buckets', async () => {
    const limiter = new FixedWindowInvitationRateLimiter(2, 1_000, 1);
    const start = new Date('2026-01-01T00:00:00.000Z');
    expect(await limiter.consume('one', start)).toBe(true);
    expect(await limiter.consume('two', start)).toBe(false);
    expect(
      await limiter.consume('two', new Date('2026-01-01T00:00:01.000Z')),
    ).toBe(true);
  });

  it('stores only a protected token and returns minimal targeted previews', async () => {
    const fixture = await setup();
    const created = await fixture.service.createInvitation(
      fixture.owner.id,
      fixture.community.id,
      {
        expiresInSeconds: 600,
        maxUses: 2,
        targetAccountId: fixture.member.id,
      },
    );
    expect(created.token).toBe(token);
    expect(created.invitation.tokenHash).toBe(protectInvitationToken(token));
    expect(created.invitation.tokenHash).not.toContain(token);
    await expect(
      fixture.service.previewInvitation(fixture.member.id, token),
    ).resolves.toEqual({
      communityId: fixture.community.id,
      communityName: fixture.community.name,
      expiresAt: created.invitation.expiresAt,
    });
    await expect(
      fixture.service.previewInvitation(fixture.outsider.id, token),
    ).rejects.toMatchObject({ code: 'invitation_unavailable' });
  });

  it('accepts atomically, is idempotent for active members, and preserves use counts', async () => {
    const fixture = await setup();
    const created = await fixture.service.createInvitation(
      fixture.owner.id,
      fixture.community.id,
      { expiresInSeconds: 600, maxUses: 1 },
    );
    const accepted = await fixture.service.acceptInvitation(
      fixture.member.id,
      created.token,
    );
    expect(accepted.status).toBe('active');
    await expect(
      fixture.service.acceptInvitation(fixture.member.id, created.token),
    ).resolves.toEqual(accepted);
    expect(
      await fixture.persistence.invitations.findById(created.invitation.id),
    ).toMatchObject({ useCount: 1, version: 2 });
    await expect(
      fixture.service.acceptInvitation(fixture.outsider.id, created.token),
    ).rejects.toMatchObject({ code: 'invitation_unavailable' });
  });

  it('allows exactly one winner for a concurrent final use', async () => {
    const fixture = await setup();
    const created = await fixture.service.createInvitation(
      fixture.owner.id,
      fixture.community.id,
      { expiresInSeconds: 600, maxUses: 1 },
    );
    const results = await Promise.allSettled([
      fixture.service.acceptInvitation(fixture.member.id, created.token, 'one'),
      fixture.service.acceptInvitation(
        fixture.outsider.id,
        created.token,
        'two',
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await fixture.persistence.invitations.findById(created.invitation.id),
    ).toMatchObject({ useCount: 1 });
  });

  it('blocks suspended and removed members while allowing a valid left member to rejoin', async () => {
    for (const status of ['suspended', 'removed'] as const) {
      const fixture = await setup();
      const membership = await fixture.service.changeMembership(
        fixture.owner.id,
        fixture.community.id,
        fixture.member.id,
        'active',
      );
      await fixture.service.changeMembership(
        fixture.owner.id,
        fixture.community.id,
        fixture.member.id,
        status,
        membership.version,
      );
      const created = await fixture.service.createInvitation(
        fixture.owner.id,
        fixture.community.id,
        { expiresInSeconds: 600, maxUses: 1 },
      );
      await expect(
        fixture.service.acceptInvitation(fixture.member.id, created.token),
      ).rejects.toMatchObject({ code: 'invitation_unavailable' });
    }
    const fixture = await setup();
    const membership = await fixture.service.changeMembership(
      fixture.owner.id,
      fixture.community.id,
      fixture.member.id,
      'active',
    );
    await fixture.service.changeMembership(
      fixture.member.id,
      fixture.community.id,
      fixture.member.id,
      'left',
      membership.version,
    );
    const created = await fixture.service.createInvitation(
      fixture.owner.id,
      fixture.community.id,
      { expiresInSeconds: 600, maxUses: 1 },
    );
    await expect(
      fixture.service.acceptInvitation(fixture.member.id, created.token),
    ).resolves.toMatchObject({ status: 'active', version: 3 });
  });

  it('rejects malformed, expired, revoked, and target-mismatched secrets uniformly', async () => {
    const fixture = await setup();
    const created = await fixture.service.createInvitation(
      fixture.owner.id,
      fixture.community.id,
      { expiresInSeconds: 600, maxUses: 1 },
    );
    await fixture.service.revokeInvitation(
      fixture.owner.id,
      created.invitation.id,
      created.invitation.version,
    );
    for (const candidate of ['bad', created.token])
      await expect(
        fixture.service.acceptInvitation(fixture.member.id, candidate),
      ).rejects.toMatchObject({ code: 'invitation_unavailable' });
    const expiredToken = 'E'.repeat(43);
    const now = Date.now();
    await fixture.persistence.invitations.create({
      ...created.invitation,
      id: crypto.randomUUID(),
      tokenHash: protectInvitationToken(expiredToken),
      createdAt: new Date(now - 120_000).toISOString(),
      expiresAt: new Date(now - 60_000).toISOString(),
      revokedAt: null,
    });
    await expect(
      fixture.service.previewInvitation(fixture.member.id, expiredToken),
    ).rejects.toMatchObject({ code: 'invitation_unavailable' });
  });

  it('linearizes revocation against acceptance without consuming after a successful revoke', async () => {
    const fixture = await setup();
    const created = await fixture.service.createInvitation(
      fixture.owner.id,
      fixture.community.id,
      { expiresInSeconds: 600, maxUses: 1 },
    );
    const results = await Promise.allSettled([
      fixture.service.revokeInvitation(
        fixture.owner.id,
        created.invitation.id,
        created.invitation.version,
      ),
      fixture.service.acceptInvitation(fixture.member.id, created.token),
    ]);
    const revoked = results[0].status === 'fulfilled';
    const accepted = results[1].status === 'fulfilled';
    expect(revoked && accepted).toBe(false);
    const stored = await fixture.persistence.invitations.findById(
      created.invitation.id,
    );
    expect(stored?.useCount).toBe(accepted ? 1 : 0);
    if (revoked) expect(stored?.revokedAt).not.toBeNull();
  });

  it('rate limits endpoints and audits successful and rejected administration', async () => {
    const persistence = new InMemoryPersistence();
    const service = new InMemoryCommunityService(
      persistence,
      undefined,
      new FixedWindowInvitationRateLimiter(1, 60_000),
      () => token,
    );
    const owner = await service.createAccount('Owner');
    const outsider = await service.createAccount('Outsider');
    const community = await service.createCommunity(owner.id, 'Audited');
    await service.createInvitation(owner.id, community.id, {
      expiresInSeconds: 600,
      maxUses: 1,
    });
    await expect(
      service.createInvitation(owner.id, community.id, {
        expiresInSeconds: 600,
        maxUses: 1,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(
      service.createInvitation(outsider.id, community.id, {
        expiresInSeconds: 600,
        maxUses: 1,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      (await persistence.auditEvents.list(community.id, { limit: 100 })).items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'invitation.create',
          outcome: 'succeeded',
        }),
        expect.objectContaining({
          action: 'invitation.create',
          outcome: 'rejected',
        }),
      ]),
    );
  });
});

async function setup() {
  const persistence = new InMemoryPersistence();
  const service = new InMemoryCommunityService(
    persistence,
    undefined,
    new FixedWindowInvitationRateLimiter(100, 60_000),
    () => token,
  );
  const owner = await service.createAccount('Owner');
  const member = await service.createAccount('Member');
  const outsider = await service.createAccount('Outsider');
  const community = await service.createCommunity(owner.id, 'Community');
  return { persistence, service, owner, member, outsider, community };
}
