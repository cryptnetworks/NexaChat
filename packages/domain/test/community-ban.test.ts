import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CommunityService, InMemoryPersistence } from '../src/index.js';

describe('community bans', () => {
  it('is rejoin-resistant, idempotent, reversible, and owner-safe', async () => {
    const service = new CommunityService(new InMemoryPersistence());
    const owner = await service.createAccount('Owner');
    const member = await service.createAccount('Member');
    const community = await service.createCommunity(owner.id, 'Community');
    await service.changeMembership(owner.id, community.id, member.id, 'active');
    const space = await service.createTextSpace(community.id, owner.id, 'chat');
    const ban = await service.banMember(
      owner.id,
      community.id,
      member.id,
      null,
      'Repeated abuse',
      'ban-request-0001',
      randomUUID(),
    );
    await expect(
      service.postMessage(space.id, member.id, 'blocked', 'ban-message-0001'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.banMember(
        owner.id,
        community.id,
        member.id,
        null,
        'Repeated abuse',
        'ban-request-0001',
        randomUUID(),
      ),
    ).resolves.toEqual(ban);
    const reversed = await service.reverseRestriction(
      owner.id,
      ban.id,
      'Review completed',
      ban.version,
      randomUUID(),
    );
    expect(reversed.revokedAt).not.toBeNull();
    await expect(
      service.postMessage(space.id, member.id, 'restored', 'ban-message-0002'),
    ).resolves.toBeDefined();
    await expect(
      service.banMember(
        owner.id,
        community.id,
        owner.id,
        null,
        'invalid',
        'ban-request-0002',
        randomUUID(),
      ),
    ).rejects.toBeDefined();
  });
});
