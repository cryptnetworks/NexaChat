import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CommunityService, InMemoryPersistence } from '../src/index.js';

describe('moderator message deletion', () => {
  it('preserves replies and evidence while returning only a tombstone', async () => {
    const service = new CommunityService(new InMemoryPersistence());
    const owner = await service.createAccount('Owner');
    const member = await service.createAccount('Member');
    const community = await service.createCommunity(owner.id, 'Community');
    await service.changeMembership(owner.id, community.id, member.id, 'active');
    const space = await service.createTextSpace(community.id, owner.id, 'chat');
    const message = await service.postMessage(
      space.id,
      member.id,
      'private evidence body',
      'moderated-message-0001',
    );
    const reply = await service.postMessage(
      space.id,
      owner.id,
      'reply remains',
      'moderated-message-0002',
      message.id,
    );
    const result = await service.moderatorDeleteMessage(
      owner.id,
      message.id,
      'Policy violation',
      'moderation-delete-0001',
      message.version,
      randomUUID(),
    );
    expect(result.message).toMatchObject({ body: null, version: 2 });
    expect(result.deletion).not.toHaveProperty('bodySnapshot');
    const history = await service.listMessages(space.id, owner.id, {
      limit: 10,
    });
    expect(history.items.find((item) => item.id === reply.id)?.replyToId).toBe(
      message.id,
    );
    await expect(
      service.moderatorDeleteMessage(
        owner.id,
        message.id,
        'Policy violation',
        'moderation-delete-0001',
        message.version,
        randomUUID(),
      ),
    ).resolves.toEqual(result);
  });
});
