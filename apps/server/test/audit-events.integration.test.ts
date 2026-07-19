import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryCommunityService } from '@nexa/domain';
import { buildApp } from '../src/app.js';

describe('administrative audit HTTP boundary', () => {
  it('provides authorized bounded query, verification, and NDJSON export', async () => {
    const service = new InMemoryCommunityService();
    const owner = await service.createAccount('Owner');
    const outsider = await service.createAccount('Outsider');
    const community = await service.createCommunity(owner.id, 'Community');
    await service.persistence.auditEvents.create({
      id: randomUUID(),
      actorId: owner.id,
      communityId: community.id,
      invitationId: null,
      action: 'invitation.create',
      outcome: 'succeeded',
      occurredAt: new Date().toISOString(),
    });
    const app = buildApp(service);

    const query = await app.inject(
      `/v1/communities/${community.id}/audit-events?actorId=${owner.id}&limit=1`,
    );
    expect(query.statusCode).toBe(200);
    expect(query.json()).toMatchObject({
      items: [{ action: 'invitation.create', sequence: 1 }],
      nextCursor: null,
    });
    const integrity = await app.inject(
      `/v1/communities/${community.id}/audit-events/integrity?actorId=${owner.id}`,
    );
    expect(integrity.statusCode).toBe(200);
    expect(integrity.json()).toMatchObject({ valid: true, count: 1 });
    const exported = await app.inject(
      `/v1/communities/${community.id}/audit-events/export?actorId=${owner.id}&limit=1`,
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('application/x-ndjson');
    expect(JSON.parse(exported.body.trim())).toMatchObject({
      actorId: owner.id,
      communityId: community.id,
    });
    expect(exported.body).not.toContain('token');

    const denied = await app.inject(
      `/v1/communities/${community.id}/audit-events?actorId=${outsider.id}`,
    );
    expect(denied.statusCode).toBe(403);
    const invalid = await app.inject(
      `/v1/communities/${community.id}/audit-events?actorId=${owner.id}&limit=101`,
    );
    expect(invalid.statusCode).toBe(400);
    const malformedCursor = await app.inject(
      `/v1/communities/${community.id}/audit-events?actorId=${owner.id}&cursor=private`,
    );
    expect(malformedCursor.statusCode).toBe(400);
    await app.close();
  });
});
