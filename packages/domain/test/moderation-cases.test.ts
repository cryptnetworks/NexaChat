import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CommunityService, InMemoryPersistence } from '../src/index.js';

describe('moderation cases', () => {
  it('protects evidence and enforces assignment, history and stale writes', async () => {
    const service = new CommunityService(new InMemoryPersistence());
    const owner = await service.createAccount('Owner');
    const reporter = await service.createAccount('Reporter');
    const community = await service.createCommunity(owner.id, 'Community');
    await service.changeMembership(
      owner.id,
      community.id,
      reporter.id,
      'active',
    );
    const report = await service.createSafetyReport(reporter.id, community.id, {
      targetAccountId: owner.id,
      category: 'other',
      description: 'Needs review',
      idempotencyKey: 'case-report-0001',
      correlationId: randomUUID(),
    });
    const moderationCase = await service.openModerationCase(
      owner.id,
      report.id,
      'open-case-0001',
      randomUUID(),
    );
    await expect(
      service.getModerationCase(reporter.id, moderationCase.id),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const investigating = await service.updateModerationCase(
      owner.id,
      moderationCase.id,
      {
        assigneeId: owner.id,
        status: 'investigating',
        note: 'Review started',
        expectedVersion: moderationCase.version,
      },
    );
    await expect(
      service.updateModerationCase(owner.id, moderationCase.id, {
        status: 'resolved',
        expectedVersion: moderationCase.version,
      }),
    ).rejects.toMatchObject({ code: 'stale_write' });
    const detail = await service.getModerationCase(owner.id, moderationCase.id);
    expect(detail.case).toEqual(investigating);
    expect(detail.report.description).toBe('Needs review');
    expect(detail.activity.map((item) => item.kind)).toEqual([
      'opened',
      'assigned',
      'status_changed',
      'note',
    ]);
  });
});
