import { describe, expect, it } from 'vitest';
import { DomainError, InMemoryCommunityService } from '../src/index.js';

describe('community vertical slice', () => {
  it('creates the owner, community, text space, and message', () => {
    const service = new InMemoryCommunityService();
    const owner = service.createAccount('Mira');
    const community = service.createCommunity(owner.id, 'Garden Workshop');
    const space = service.createTextSpace(community.id, owner.id, 'planning');
    const message = service.postMessage(
      space.id,
      owner.id,
      'First gathering is Saturday.',
    );
    expect(message).toMatchObject({ spaceId: space.id, authorId: owner.id });
  });

  it('prevents a non-owner from creating a space', () => {
    const service = new InMemoryCommunityService();
    const owner = service.createAccount('Owner');
    const other = service.createAccount('Other');
    const community = service.createCommunity(owner.id, 'Community');
    expect(() =>
      service.createTextSpace(community.id, other.id, 'private'),
    ).toThrowError(DomainError);
  });

  it('authorizes only the owning account to subscribe to a space', () => {
    const service = new InMemoryCommunityService();
    const owner = service.createAccount('Owner');
    const other = service.createAccount('Other');
    const community = service.createCommunity(owner.id, 'Community');
    const space = service.createTextSpace(community.id, owner.id, 'general');
    expect(() => {
      service.authorizeSpaceSubscription(space.id, owner.id);
    }).not.toThrow();
    expect(() => {
      service.authorizeSpaceSubscription(space.id, other.id);
    }).toThrowError(DomainError);
  });
});
