import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CommunityService, InMemoryPersistence } from '../src/index.js';

describe('moderation appeals', () => {
  it('bounds submissions and safely restores an overturned restriction', async () => {
    const persistence = new InMemoryPersistence();
    const service = new CommunityService(
      persistence,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );
    const owner = await service.createAccount('Owner');
    const member = await service.createAccount('Member');
    const community = await service.createCommunity(owner.id, 'Community');
    await service.changeMembership(owner.id, community.id, member.id, 'active');
    const space = await service.createTextSpace(community.id, owner.id, 'chat');
    const restriction = await service.banMember(
      owner.id,
      community.id,
      member.id,
      null,
      'Abuse',
      'appeal-ban-0001',
      randomUUID(),
    );
    const appeal = await service.submitModerationAppeal(
      member.id,
      restriction.id,
      'Please review',
      'appeal-submit-0001',
      randomUUID(),
    );
    await expect(
      service.submitModerationAppeal(
        member.id,
        restriction.id,
        'Second appeal',
        'appeal-submit-0002',
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    const decided = await service.decideModerationAppeal(
      owner.id,
      appeal.id,
      'overturned',
      'New evidence',
      appeal.version,
      randomUUID(),
    );
    expect(decided.status).toBe('overturned');
    await expect(
      service.postMessage(
        space.id,
        member.id,
        'restored',
        'appeal-message-0001',
      ),
    ).resolves.toBeDefined();
  });
});
