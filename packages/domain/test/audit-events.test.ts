import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InMemoryCommunityService,
  InMemoryPersistence,
  type AuditEventInput,
} from '../src/index.js';

describe('tamper-evident administrative audit events', () => {
  it('authorizes bounded pagination and exports only allowlisted fields', async () => {
    const fixture = await setup();
    for (let index = 0; index < 3; index += 1)
      await fixture.persistence.auditEvents.create(
        auditInput(fixture.owner.id, fixture.community.id, {
          action: 'invitation.create',
          outcome: 'succeeded',
          occurredAt: new Date(1_700_000_000_000 + index).toISOString(),
        }),
      );

    const first = await fixture.service.listAuditEvents(
      fixture.owner.id,
      fixture.community.id,
      { limit: 2 },
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    if (!first.nextCursor) throw new Error('audit cursor missing');
    const second = await fixture.service.listAuditEvents(
      fixture.owner.id,
      fixture.community.id,
      { limit: 2, cursor: first.nextCursor },
    );
    expect(second.items).toHaveLength(1);
    expect(Object.keys(first.items[0] ?? {}).sort()).toEqual(
      [
        'action',
        'actorId',
        'actorType',
        'correlationId',
        'eventHash',
        'id',
        'occurredAt',
        'outcome',
        'previousHash',
        'reasonCode',
        'retentionUntil',
        'sequence',
        'scopeId',
        'scopeType',
        'targetId',
        'targetType',
        'version',
      ].sort(),
    );
    await expect(
      fixture.service.listAuditEvents(
        fixture.outsider.id,
        fixture.community.id,
        { limit: 10 },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('detects tampering and chains concurrent appends deterministically', async () => {
    const fixture = await setup();
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        fixture.persistence.auditEvents.create(
          auditInput(fixture.owner.id, fixture.community.id, {
            action: 'invitation.revoke',
            outcome: index % 2 ? 'rejected' : 'succeeded',
            occurredAt: new Date(1_700_000_000_000 + index).toISOString(),
          }),
        ),
      ),
    );
    await expect(
      fixture.service.verifyAuditEvents(fixture.owner.id, fixture.community.id),
    ).resolves.toMatchObject({ valid: true, count: 25 });

    const page = await fixture.persistence.auditEvents.list(
      fixture.community.id,
      { limit: 1 },
    );
    const first = page.items[0];
    if (!first) throw new Error('audit fixture missing');
    first.eventHash = 'f'.repeat(64);
    await expect(
      fixture.service.verifyAuditEvents(fixture.owner.id, fixture.community.id),
    ).resolves.toMatchObject({ valid: false, count: 25 });
  });

  it('rejects duplicate event identifiers without rewriting the chain', async () => {
    const fixture = await setup();
    const event = auditInput(fixture.owner.id, fixture.community.id, {
      action: 'invitation.create' as const,
      outcome: 'succeeded' as const,
      occurredAt: new Date().toISOString(),
    });
    await fixture.persistence.auditEvents.create(event);
    await expect(
      fixture.persistence.auditEvents.create(event),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      fixture.persistence.auditEvents.verify(fixture.community.id),
    ).resolves.toMatchObject({ valid: true, count: 1 });
  });

  it('records service identity, correlations, checkpoints, retention, and append-only legal-hold directives', async () => {
    const fixture = await setup();
    const occurredAt = '2010-01-01T00:00:00.000Z';
    await fixture.persistence.auditEvents.create({
      ...auditInput(fixture.owner.id, fixture.community.id, {
        action: 'invitation.create',
        outcome: 'succeeded',
        occurredAt,
      }),
      actorType: 'service',
      actorId: 'integrity-monitor',
      targetType: 'audit_chain',
      targetId: fixture.community.id,
    });
    const correlationId = randomUUID();
    const held = await fixture.service.setAuditLegalHold(
      fixture.owner.id,
      fixture.community.id,
      true,
      'litigation_hold',
      correlationId,
    );
    expect(held).toMatchObject({
      version: 1,
      actorType: 'account',
      actorId: fixture.owner.id,
      scopeType: 'community',
      scopeId: fixture.community.id,
      targetType: 'community',
      targetId: fixture.community.id,
      action: 'audit.legal_hold.apply',
      reasonCode: 'litigation_hold',
      correlationId,
    });
    await expect(
      fixture.service.auditRetention(
        fixture.owner.id,
        fixture.community.id,
        '2030-01-01T00:00:00.000Z',
      ),
    ).resolves.toEqual({
      policy: 'security_7y',
      legalHold: true,
      eligibleThroughSequence: 0,
    });
    await fixture.service.setAuditLegalHold(
      fixture.owner.id,
      fixture.community.id,
      false,
      'litigation_released',
    );
    await expect(
      fixture.service.auditRetention(
        fixture.owner.id,
        fixture.community.id,
        '2030-01-01T00:00:00.000Z',
      ),
    ).resolves.toMatchObject({
      legalHold: false,
      eligibleThroughSequence: 1,
    });
    const checkpoint = await fixture.service.checkpointAuditEvents(
      fixture.owner.id,
      fixture.community.id,
    );
    await expect(
      fixture.service.verifyAuditEvents(fixture.owner.id, fixture.community.id),
    ).resolves.toMatchObject({
      valid: true,
      checkpointSequence: checkpoint.sequence,
      checkpointHash: checkpoint.headHash,
      checkpointValid: true,
    });

    const page = await fixture.persistence.auditEvents.list(
      fixture.community.id,
      { limit: 100 },
    );
    const checkpointed = page.items.at(-1);
    if (!checkpointed) throw new Error('checkpoint event missing');
    checkpointed.eventHash = 'e'.repeat(64);
    await expect(
      fixture.persistence.auditEvents.verify(fixture.community.id),
    ).resolves.toMatchObject({ valid: false, checkpointValid: false });
  });
});

async function setup() {
  const persistence = new InMemoryPersistence();
  const service = new InMemoryCommunityService(persistence);
  const owner = await service.createAccount('Owner');
  const outsider = await service.createAccount('Outsider');
  const community = await service.createCommunity(owner.id, 'Audit Community');
  return { persistence, service, owner, outsider, community };
}

function auditInput(
  actorId: string,
  communityId: string,
  input: Pick<AuditEventInput, 'action' | 'occurredAt' | 'outcome'>,
): AuditEventInput {
  const retention = new Date(input.occurredAt);
  retention.setUTCFullYear(retention.getUTCFullYear() + 7);
  return {
    version: 1,
    id: randomUUID(),
    actorType: 'account',
    actorId,
    scopeType: 'community',
    scopeId: communityId,
    targetType: 'none',
    targetId: null,
    reasonCode: null,
    correlationId: randomUUID(),
    retentionUntil: retention.toISOString(),
    ...input,
  };
}
