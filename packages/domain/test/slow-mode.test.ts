import { describe, expect, it } from 'vitest';
import { CommunityService, InMemoryPersistence } from '../src/index.js';

describe('message slow mode', () => {
  it('uses transactional pacing, stable retry timing, and owner bypass', async () => {
    const service = new CommunityService(new InMemoryPersistence());
    const owner = await service.createAccount('Owner');
    const member = await service.createAccount('Member');
    const community = await service.createCommunity(owner.id, 'Community');
    await service.changeMembership(owner.id, community.id, member.id, 'active');
    const original = await service.createTextSpace(
      community.id,
      owner.id,
      'chat',
    );
    const space = await service.updateSpace(owner.id, original.id, {
      slowModeSeconds: 30,
      expectedVersion: original.version,
    });
    await service.postMessage(space.id, member.id, 'first', 'slow-mode-0001');
    const raced = await Promise.allSettled([
      service.postMessage(space.id, member.id, 'second', 'slow-mode-0002'),
      service.postMessage(space.id, member.id, 'third', 'slow-mode-0003'),
    ]);
    expect(raced.every((result) => result.status === 'rejected')).toBe(true);
    expect((raced[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 30,
    });
    await expect(
      service.postMessage(
        space.id,
        owner.id,
        'moderator one',
        'slow-mode-0004',
      ),
    ).resolves.toBeDefined();
    await expect(
      service.postMessage(
        space.id,
        owner.id,
        'moderator two',
        'slow-mode-0005',
      ),
    ).resolves.toBeDefined();
  });
});
