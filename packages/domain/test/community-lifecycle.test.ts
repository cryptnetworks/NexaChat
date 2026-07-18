import { describe, expect, it } from 'vitest';
import {
  CommunityService,
  InMemoryPersistence,
  type AuthorizationGateway,
  type Community,
} from '../src/index.js';

async function fixture(authorization?: AuthorizationGateway) {
  const persistence = new InMemoryPersistence();
  const service = new CommunityService(persistence, authorization);
  const owner = await service.createAccount('  Owner   Name  ');
  const member = await service.createAccount('Member');
  const outsider = await service.createAccount('Outsider');
  const community = await service.createCommunity(owner.id, '  Core   Team ');
  return { persistence, service, owner, member, outsider, community };
}

describe('community lifecycle', () => {
  it('normalizes creation and atomically creates the active owner membership', async () => {
    const { persistence, owner, community } = await fixture();
    expect(community).toMatchObject({ name: 'Core Team', version: 1 });
    await expect(
      persistence.memberships.findByCommunityAndAccount(community.id, owner.id),
    ).resolves.toMatchObject({ status: 'active', version: 1 });
  });

  it('rolls community creation back when owner membership creation fails', async () => {
    const persistence = new InMemoryPersistence();
    const service = new CommunityService(persistence);
    const owner = await service.createAccount('Owner');
    let attempted: Community | undefined;
    const createCommunity = persistence.communities.create;
    Object.defineProperty(persistence.communities, 'create', {
      value: async (community: Community) => {
        attempted = community;
        return createCommunity(community);
      },
    });
    Object.defineProperty(persistence.memberships, 'create', {
      value: () => Promise.reject(new Error('membership failed')),
    });
    await expect(service.createCommunity(owner.id, 'Rollback')).rejects.toThrow(
      'membership failed',
    );
    expect(attempted).toBeDefined();
    await expect(
      persistence.communities.findById(attempted?.id ?? ''),
    ).resolves.toBeUndefined();
  });

  it('lists only active memberships and excludes left or suspended members', async () => {
    const { service, owner, member, outsider, community } = await fixture();
    const membership = await service.changeMembership(
      owner.id,
      community.id,
      member.id,
      'active',
    );
    await expect(
      service.listCommunities(member.id, { limit: 10 }),
    ).resolves.toMatchObject({ items: [{ id: community.id }] });
    const suspended = await service.changeMembership(
      owner.id,
      community.id,
      member.id,
      'suspended',
      membership.version,
    );
    await expect(
      service.listCommunities(member.id, { limit: 10 }),
    ).resolves.toMatchObject({ items: [] });
    const invited = await service.changeMembership(
      owner.id,
      community.id,
      member.id,
      'invited',
      suspended.version,
    );
    expect(invited.status).toBe('invited');
    const rejoined = await service.changeMembership(
      owner.id,
      community.id,
      member.id,
      'active',
      invited.version,
    );
    const removed = await service.changeMembership(
      owner.id,
      community.id,
      member.id,
      'removed',
      rejoined.version,
    );
    expect(removed.status).toBe('removed');
    await expect(
      service.listCommunities(outsider.id, { limit: 10 }),
    ).resolves.toMatchObject({ items: [] });
  });

  it('supports leaving and removal while protecting the sole owner', async () => {
    const { service, owner, member, community } = await fixture();
    const joined = await service.changeMembership(
      owner.id,
      community.id,
      member.id,
      'active',
    );
    await expect(
      service.changeMembership(
        member.id,
        community.id,
        member.id,
        'left',
        joined.version,
      ),
    ).resolves.toMatchObject({ status: 'left' });
    await expect(
      service.changeMembership(owner.id, community.id, owner.id, 'left'),
    ).rejects.toMatchObject({ code: 'sole_owner' });
    await expect(
      service.changeMembership(owner.id, community.id, owner.id, 'removed'),
    ).rejects.toMatchObject({ code: 'sole_owner' });
  });

  it('manages category lifecycle, normalized uniqueness, ordering, and stale writes', async () => {
    const { persistence, service, owner, community } = await fixture();
    const first = await service.createCategory(
      owner.id,
      community.id,
      ' General ',
    );
    const second = await service.createCategory(
      owner.id,
      community.id,
      'Projects',
    );
    const linkedSpace = await service.createTextSpace(
      community.id,
      owner.id,
      'Linked',
      first.id,
    );
    const historicalMessage = await service.postMessage(
      linkedSpace.id,
      owner.id,
      'Keep me',
    );
    await expect(
      service.createCategory(owner.id, community.id, 'general'),
    ).rejects.toMatchObject({ code: 'conflict' });
    const reordered = await service.updateCategory(owner.id, second.id, {
      position: 0,
      expectedVersion: second.version,
    });
    await expect(
      service.updateCategory(owner.id, second.id, {
        name: 'Stale',
        expectedVersion: second.version,
      }),
    ).rejects.toMatchObject({ code: 'stale_write' });
    await service.updateCategory(owner.id, first.id, {
      archived: true,
      expectedVersion: first.version,
    });
    await expect(
      service.listCategories(owner.id, community.id),
    ).resolves.toEqual([reordered]);
    await expect(
      service.listSpaces(owner.id, community.id, { limit: 10 }),
    ).resolves.toMatchObject({ items: [] });
    await expect(persistence.spaces.findById(linkedSpace.id)).resolves.toEqual(
      linkedSpace,
    );
    await expect(
      persistence.messages.findById(historicalMessage.id),
    ).resolves.toEqual(historicalMessage);
  });

  it('manages text-space assignment, pagination, concurrent writes, and archival history', async () => {
    const { persistence, service, owner, community } = await fixture();
    const category = await service.createCategory(
      owner.id,
      community.id,
      'General',
    );
    const first = await service.createTextSpace(
      community.id,
      owner.id,
      'One',
      category.id,
    );
    const second = await service.createTextSpace(
      community.id,
      owner.id,
      'Two',
      category.id,
    );
    await service.createTextSpace(community.id, owner.id, 'Three');
    await expect(
      service.createTextSpace(community.id, owner.id, ' one '),
    ).rejects.toMatchObject({ code: 'conflict' });

    const pageOne = await service.listSpaces(owner.id, community.id, {
      limit: 2,
    });
    expect(pageOne.items).toHaveLength(2);
    expect(pageOne.nextCursor).toBeTypeOf('string');
    if (!pageOne.nextCursor) throw new Error('expected a second page');
    const pageTwo = await service.listSpaces(owner.id, community.id, {
      limit: 2,
      cursor: pageOne.nextCursor,
    });
    expect(pageTwo.items).toHaveLength(1);
    expect(
      new Set([...pageOne.items, ...pageTwo.items].map((item) => item.id)).size,
    ).toBe(3);

    const competing = await Promise.allSettled([
      service.updateSpace(owner.id, second.id, {
        name: 'Renamed',
        position: 0,
        expectedVersion: second.version,
      }),
      service.updateSpace(owner.id, second.id, {
        name: 'Other',
        expectedVersion: second.version,
      }),
    ]);
    expect(
      competing.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      competing.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);

    const message = await service.postMessage(first.id, owner.id, 'History');
    await service.updateSpace(owner.id, first.id, {
      archived: true,
      expectedVersion: first.version,
    });
    const visible = await service.listSpaces(owner.id, community.id, {
      limit: 10,
    });
    expect(visible.items.map((item) => item.id)).not.toContain(first.id);
    await expect(persistence.messages.findById(message.id)).resolves.toEqual(
      message,
    );
  });

  it('routes every managed command through the permission gateway and preserves denial', async () => {
    const calls: string[] = [];
    const authorization: AuthorizationGateway = {
      enforce(_actorId, permission) {
        calls.push(permission);
        return permission === 'category.manage'
          ? Promise.reject(new Error('denied'))
          : Promise.resolve();
      },
    };
    const { service, owner, community } = await fixture(authorization);
    await expect(
      service.createCategory(owner.id, community.id, 'Denied'),
    ).rejects.toThrow('denied');
    await service.getCommunity(owner.id, community.id);
    expect(calls).toEqual(['category.manage', 'community.view']);
  });

  it('rejects invalid page bounds and stale concurrent community renames', async () => {
    const { service, owner, community } = await fixture();
    await expect(
      service.listCommunities(owner.id, { limit: 101 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const results = await Promise.allSettled([
      service.updateCommunity(
        owner.id,
        community.id,
        'First',
        community.version,
      ),
      service.updateCommunity(
        owner.id,
        community.id,
        'Second',
        community.version,
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });
});
