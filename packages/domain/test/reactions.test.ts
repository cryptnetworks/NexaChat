import { describe, expect, it } from 'vitest';
import { CommunityService, InMemoryPersistence } from '../src/index.js';

describe('message reactions', () => {
  it('normalizes, deduplicates, aggregates and removes atomically', async () => {
    const service = new CommunityService(new InMemoryPersistence());
    const owner = await service.createAccount('Owner');
    const member = await service.createAccount('Member');
    const community = await service.createCommunity(owner.id, 'Community');
    await service.changeMembership(owner.id, community.id, member.id, 'active');
    const space = await service.createTextSpace(community.id, owner.id, 'chat');
    const message = await service.postMessage(
      space.id,
      owner.id,
      'hello',
      'reaction-message',
    );
    await Promise.all([
      service.addReaction(message.id, owner.id, '👍'),
      service.addReaction(message.id, owner.id, '👍'),
      service.addReaction(message.id, member.id, '👍'),
    ]);
    await expect(service.listReactions(message.id, owner.id)).resolves.toEqual([
      { key: '👍', count: 2, reactedByActor: true },
    ]);
    await service.removeReaction(message.id, owner.id, '👍');
    await service.removeReaction(message.id, owner.id, '👍');
    await expect(service.listReactions(message.id, owner.id)).resolves.toEqual([
      { key: '👍', count: 1, reactedByActor: false },
    ]);
    await expect(
      service.addReaction(message.id, owner.id, 'text'),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
