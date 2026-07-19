import { describe, expect, it } from 'vitest';
import { DomainError, InMemoryCommunityService } from '../src/index.js';

describe('community vertical slice', () => {
  it('creates the owner, community, text space, and message', async () => {
    const service = new InMemoryCommunityService();
    const owner = await service.createAccount('Mira');
    const community = await service.createCommunity(
      owner.id,
      'Garden Workshop',
    );
    const space = await service.createTextSpace(
      community.id,
      owner.id,
      'planning',
    );
    const message = await service.postMessage(
      space.id,
      owner.id,
      'First gathering is Saturday.',
    );
    expect(message).toMatchObject({ spaceId: space.id, authorId: owner.id });
  });

  it('prevents a non-owner from creating a space', async () => {
    const service = new InMemoryCommunityService();
    const owner = await service.createAccount('Owner');
    const other = await service.createAccount('Other');
    const community = await service.createCommunity(owner.id, 'Community');
    await expect(
      service.createTextSpace(community.id, other.id, 'private'),
    ).rejects.toThrowError(DomainError);
  });

  it('authorizes only the owning account to subscribe to a space', async () => {
    const service = new InMemoryCommunityService();
    const owner = await service.createAccount('Owner');
    const other = await service.createAccount('Other');
    const community = await service.createCommunity(owner.id, 'Community');
    const space = await service.createTextSpace(
      community.id,
      owner.id,
      'general',
    );
    await expect(
      service.authorizeSpaceSubscription(space.id, owner.id),
    ).resolves.toBeUndefined();
    await expect(
      service.authorizeSpaceSubscription(space.id, other.id),
    ).rejects.toThrowError(DomainError);
  });
});
