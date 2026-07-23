import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CommunityService,
  InMemoryPersistence,
  type AuthorizationGateway,
} from '../src/index.js';

async function fixture(authorization?: AuthorizationGateway) {
  const persistence = new InMemoryPersistence();
  const service = new CommunityService(persistence, authorization);
  const owner = await service.createAccount('Owner');
  const member = await service.createAccount('Member');
  const community = await service.createCommunity(owner.id, 'Community');
  await service.changeMembership(owner.id, community.id, member.id, 'active');
  const space = await service.createTextSpace(community.id, owner.id, 'chat');
  return { persistence, service, owner, member, community, space };
}

describe('member timeouts', () => {
  it('is idempotent and immediately revokes HTTP and realtime authorization', async () => {
    const { service, owner, member, community, space } = await fixture();
    const correlation = randomUUID();
    const first = await service.timeoutMember(
      owner.id,
      community.id,
      member.id,
      60,
      'Repeated disruption',
      'timeout-0001',
      correlation,
    );
    const replay = await service.timeoutMember(
      owner.id,
      community.id,
      member.id,
      60,
      'Repeated disruption',
      'timeout-0001',
      randomUUID(),
    );
    expect(replay).toEqual(first);
    await expect(
      service.listMessages(space.id, member.id, { limit: 10 }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.authorizeSpaceSubscription(space.id, member.id),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.timeoutMember(
        owner.id,
        community.id,
        member.id,
        120,
        'changed',
        'timeout-0001',
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('remains authoritative when a scoped authorization gateway is active', async () => {
    const authorization: AuthorizationGateway = {
      enforce: () => Promise.resolve(),
      assertCanModerate: () => Promise.resolve(),
    };
    const { service, owner, member, community, space } =
      await fixture(authorization);
    await service.timeoutMember(
      owner.id,
      community.id,
      member.id,
      60,
      'Repeated disruption',
      'timeout-authorization-gateway',
      randomUUID(),
    );

    await expect(
      service.listMessages(space.id, member.id, { limit: 10 }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.authorizeSpaceSubscription(space.id, member.id),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('protects the sole owner and bounds reasons and duration', async () => {
    const { service, owner, member, community } = await fixture();
    await expect(
      service.timeoutMember(
        owner.id,
        community.id,
        owner.id,
        60,
        'invalid',
        'timeout-0002',
        randomUUID(),
      ),
    ).rejects.toBeDefined();
    await expect(
      service.timeoutMember(
        owner.id,
        community.id,
        member.id,
        59,
        'invalid',
        'timeout-0003',
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
