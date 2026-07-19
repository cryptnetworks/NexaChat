import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryCommunityService, InMemoryPersistence } from '../src/index.js';

describe('tamper-evident administrative audit events', () => {
  it('authorizes bounded pagination and exports only allowlisted fields', async () => {
    const fixture = await setup();
    for (let index = 0; index < 3; index += 1)
      await fixture.persistence.auditEvents.create({
        id: randomUUID(),
        actorId: fixture.owner.id,
        communityId: fixture.community.id,
        invitationId: null,
        action: 'invitation.create',
        outcome: 'succeeded',
        occurredAt: new Date(1_700_000_000_000 + index).toISOString(),
      });

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
        'communityId',
        'eventHash',
        'id',
        'invitationId',
        'occurredAt',
        'outcome',
        'previousHash',
        'sequence',
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
        fixture.persistence.auditEvents.create({
          id: randomUUID(),
          actorId: fixture.owner.id,
          communityId: fixture.community.id,
          invitationId: null,
          action: 'invitation.revoke',
          outcome: index % 2 ? 'rejected' : 'succeeded',
          occurredAt: new Date(1_700_000_000_000 + index).toISOString(),
        }),
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
    const event = {
      id: randomUUID(),
      actorId: fixture.owner.id,
      communityId: fixture.community.id,
      invitationId: null,
      action: 'invitation.create' as const,
      outcome: 'succeeded' as const,
      occurredAt: new Date().toISOString(),
    };
    await fixture.persistence.auditEvents.create(event);
    await expect(
      fixture.persistence.auditEvents.create(event),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      fixture.persistence.auditEvents.verify(fixture.community.id),
    ).resolves.toMatchObject({ valid: true, count: 1 });
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
