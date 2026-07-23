import { describe, expect, it } from 'vitest';
import { CommunityService, InMemoryPersistence } from '../src/index.js';

async function fixture() {
  const persistence = new InMemoryPersistence();
  const service = new CommunityService(persistence);
  const owner = await service.createAccount('Owner');
  const member = await service.createAccount('Member');
  const outsider = await service.createAccount('Outsider');
  const community = await service.createCommunity(owner.id, 'Community');
  await service.changeMembership(owner.id, community.id, member.id, 'active');
  const space = await service.createTextSpace(
    community.id,
    owner.id,
    'messages',
  );
  return { persistence, service, owner, member, outsider, community, space };
}

describe('message lifecycle', () => {
  it('normalizes content and makes retried creation idempotent', async () => {
    const { persistence, service, owner, space } = await fixture();
    const first = await service.postMessage(
      space.id,
      owner.id,
      '  hello\r\nworld  ',
      'request-0001',
    );
    const retried = await service.postMessage(
      space.id,
      owner.id,
      '  hello\r\nworld  ',
      'request-0001',
    );
    expect(retried).toEqual(first);
    expect(first.body).toBe('hello\nworld');
    await expect(
      persistence.messages.list(space.id, { limit: 10 }),
    ).resolves.toMatchObject({ items: [first] });
    await expect(
      service.postMessage(space.id, owner.id, 'changed', 'request-0001'),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('linearizes concurrent idempotency retries and rejects payload collisions', async () => {
    const { service, owner, space } = await fixture();
    const retried = await Promise.all([
      service.postMessageCommand(
        space.id,
        owner.id,
        'same',
        'request-concurrent-0001',
      ),
      service.postMessageCommand(
        space.id,
        owner.id,
        'same',
        'request-concurrent-0001',
      ),
    ]);
    expect(new Set(retried.map((result) => result.message.id)).size).toBe(1);
    expect(retried.map((result) => result.existing).sort()).toEqual([
      false,
      true,
    ]);

    const collision = await Promise.allSettled([
      service.postMessageCommand(
        space.id,
        owner.id,
        'first',
        'request-concurrent-0002',
      ),
      service.postMessageCommand(
        space.id,
        owner.id,
        'second',
        'request-concurrent-0002',
      ),
    ]);
    expect(
      collision.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      collision.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { code: 'conflict' } });
  });

  it('replays accepted requests after limit changes and rejects archived scopes', async () => {
    const { service, owner, community, space } = await fixture();
    const first = await service.postMessageCommand(
      space.id,
      owner.id,
      'accepted body',
      'request-policy-change-0001',
    );
    await service.updateContentLimits(owner.id, community.id, {
      messageBodyMax: 1,
      reportDescriptionMax: 100,
      moderationReasonMax: 50,
      correlationId: '00000000-0000-4000-8000-000000000099',
    });
    await expect(
      service.postMessageCommand(
        space.id,
        owner.id,
        'accepted body',
        'request-policy-change-0001',
      ),
    ).resolves.toEqual({ message: first.message, existing: true });

    await service.archiveCommunity(owner.id, community.id, community.version);
    await expect(
      service.postMessage(
        space.id,
        owner.id,
        'new body',
        'request-archived-community-0001',
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('validates reply references without exposing other spaces', async () => {
    const { service, owner, community, space } = await fixture();
    const other = await service.createTextSpace(
      community.id,
      owner.id,
      'other',
    );
    const parent = await service.postMessage(
      other.id,
      owner.id,
      'parent',
      'request-0002',
    );
    await expect(
      service.postMessage(
        space.id,
        owner.id,
        'reply',
        'request-0003',
        parent.id,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('paginates deterministically without duplicates', async () => {
    const { service, owner, space } = await fixture();
    for (let index = 0; index < 5; index += 1)
      await service.postMessage(
        space.id,
        owner.id,
        `message ${String(index)}`,
        `request-100${String(index)}`,
      );
    const first = await service.listMessages(space.id, owner.id, { limit: 2 });
    expect(first.items).toHaveLength(2);
    if (!first.nextCursor) throw new Error('expected cursor');
    const second = await service.listMessages(space.id, owner.id, {
      limit: 3,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(3);
    expect(
      new Set([...first.items, ...second.items].map((v) => v.id)).size,
    ).toBe(5);
  });

  it('returns the newest authorized page in chronological order when paging backward', async () => {
    const { service, owner, space } = await fixture();
    for (let index = 0; index < 5; index += 1)
      await service.postMessage(
        space.id,
        owner.id,
        `message ${String(index)}`,
        `request-200${String(index)}`,
      );
    const all = await service.listMessages(space.id, owner.id, { limit: 5 });
    const latest = await service.listMessages(space.id, owner.id, {
      limit: 2,
      direction: 'backward',
    });
    expect(latest.items).toEqual(all.items.slice(-2));
    if (!latest.nextCursor) throw new Error('expected older cursor');
    const older = await service.listMessages(space.id, owner.id, {
      limit: 3,
      cursor: latest.nextCursor,
      direction: 'backward',
    });
    expect(older.items).toEqual(all.items.slice(0, 3));
    expect(
      new Set([...latest.items, ...older.items].map((message) => message.id))
        .size,
    ).toBe(5);
  });

  it('enforces authorship, active membership, and stale edit protection', async () => {
    const { service, owner, member, outsider, space } = await fixture();
    const message = await service.postMessage(
      space.id,
      owner.id,
      'original',
      'request-0004',
    );
    await expect(
      service.editMessage(message.id, outsider.id, 'hidden', message.version),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const edited = await service.editMessage(
      message.id,
      owner.id,
      'edited',
      message.version,
    );
    await expect(
      service.editMessage(message.id, owner.id, 'stale', message.version),
    ).rejects.toMatchObject({ code: 'stale_write' });
    const membership = await service.listMemberships(
      owner.id,
      space.communityId,
    );
    const memberRecord = membership.find(
      (value) => value.accountId === member.id,
    );
    if (!memberRecord) throw new Error('member missing');
    await service.changeMembership(
      owner.id,
      space.communityId,
      member.id,
      'suspended',
      memberRecord.version,
    );
    await expect(
      service.listMessages(space.id, member.id, { limit: 10 }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(edited.version).toBe(2);
  });

  it('uses tombstones and gives edit/delete races one winner', async () => {
    const { service, owner, space } = await fixture();
    const parent = await service.postMessage(
      space.id,
      owner.id,
      'parent',
      'request-0005',
    );
    const reply = await service.postMessage(
      space.id,
      owner.id,
      'reply',
      'request-0006',
      parent.id,
    );
    const results = await Promise.allSettled([
      service.editMessage(parent.id, owner.id, 'edited', parent.version),
      service.deleteMessage(parent.id, owner.id, parent.version),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const current = await service.listMessages(space.id, owner.id, {
      limit: 10,
    });
    const storedParent = current.items.find((value) => value.id === parent.id);
    expect(storedParent).toBeDefined();
    expect(reply.replyToId).toBe(parent.id);
    if (storedParent?.deletedAt) expect(storedParent.body).toBeNull();
  });

  it('rejects history and mutations after space archival', async () => {
    const { service, owner, space } = await fixture();
    const message = await service.postMessage(
      space.id,
      owner.id,
      'history',
      'request-0007',
    );
    await service.updateSpace(owner.id, space.id, {
      archived: true,
      expectedVersion: space.version,
    });
    await expect(
      service.listMessages(space.id, owner.id, { limit: 10 }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      service.deleteMessage(message.id, owner.id, message.version),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
