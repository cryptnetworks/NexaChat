import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CommunityService, InMemoryPersistence } from '../src/index.js';

describe('safety reports', () => {
  it('deduplicates reports and keeps reporter evidence private', async () => {
    const service = new CommunityService(new InMemoryPersistence());
    const owner = await service.createAccount('Owner');
    const reporter = await service.createAccount('Reporter');
    const other = await service.createAccount('Other');
    const community = await service.createCommunity(owner.id, 'Community');
    await service.changeMembership(
      owner.id,
      community.id,
      reporter.id,
      'active',
    );
    await service.changeMembership(owner.id, community.id, other.id, 'active');
    const space = await service.createTextSpace(community.id, owner.id, 'chat');
    const message = await service.postMessage(
      space.id,
      other.id,
      'reportable',
      'report-message-0001',
    );
    const input = {
      targetMessageId: message.id,
      category: 'harassment' as const,
      description: 'Targeted abuse',
      evidenceReferenceIds: [randomUUID()],
      idempotencyKey: 'safety-report-0001',
      correlationId: randomUUID(),
    };
    const report = await service.createSafetyReport(
      reporter.id,
      community.id,
      input,
    );
    await expect(
      service.createSafetyReport(reporter.id, community.id, {
        ...input,
        correlationId: randomUUID(),
      }),
    ).resolves.toEqual(report);
    await expect(
      service.getOwnSafetyReport(other.id, report.id),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      service.getOwnSafetyReport(reporter.id, report.id),
    ).resolves.toMatchObject({ status: 'submitted' });
  });

  it('bounds reporter submissions without exposing thresholds in the result', async () => {
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
    for (let index = 0; index < 10; index += 1)
      await service.createSafetyReport(reporter.id, community.id, {
        targetAccountId: owner.id,
        category: 'spam',
        description: `Report ${String(index)}`,
        idempotencyKey: `report-limit-${String(index).padStart(4, '0')}`,
        correlationId: randomUUID(),
      });
    await expect(
      service.createSafetyReport(reporter.id, community.id, {
        targetAccountId: owner.id,
        category: 'spam',
        description: 'One too many',
        idempotencyKey: 'report-limit-over',
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });
});
