import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CommunityService, InMemoryPersistence } from '../src/index.js';

describe('configurable content limits', () => {
  it('applies bounded overrides consistently and rejects stale updates', async () => {
    const service = new CommunityService(new InMemoryPersistence());
    const owner = await service.createAccount('Owner');
    const community = await service.createCommunity(owner.id, 'Community');
    const space = await service.createTextSpace(community.id, owner.id, 'chat');
    const limits = await service.updateContentLimits(owner.id, community.id, {
      messageBodyMax: 10,
      reportDescriptionMax: 100,
      moderationReasonMax: 50,
      correlationId: randomUUID(),
    });
    await expect(
      service.postMessage(
        space.id,
        owner.id,
        '12345678901',
        'limit-message-0001',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      service.updateContentLimits(owner.id, community.id, {
        messageBodyMax: 20,
        reportDescriptionMax: 100,
        moderationReasonMax: 50,
        expectedVersion: limits.version - 1,
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'stale_write' });
  });
});
