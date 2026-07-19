import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryCommunityService, type AuditEventInput } from '@nexa/domain';
import { buildApp } from '../src/app.js';
import { Telemetry } from '../src/telemetry.js';

describe('administrative audit HTTP boundary', () => {
  it('provides authorized bounded query, verification, and NDJSON export', async () => {
    const service = new InMemoryCommunityService();
    const owner = await service.createAccount('Owner');
    const outsider = await service.createAccount('Outsider');
    const community = await service.createCommunity(owner.id, 'Community');
    await service.persistence.auditEvents.create(
      auditInput(owner.id, community.id, {
        action: 'invitation.create',
        outcome: 'succeeded',
        occurredAt: new Date().toISOString(),
      }),
    );
    const telemetry = new Telemetry({ traceSampleRate: 0 });
    const app = buildApp(
      service,
      undefined,
      undefined,
      undefined,
      undefined,
      telemetry,
    );

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
    expect(integrity.json()).toMatchObject({
      valid: true,
      count: 1,
      checkpointValid: true,
    });
    expect(telemetry.metrics.render()).toContain(
      'nexa_audit_integrity_checks_total{outcome="valid"} 1',
    );
    const checkpoint = await app.inject({
      method: 'POST',
      url: `/v1/communities/${community.id}/audit-events/checkpoints`,
      payload: { actorId: owner.id },
    });
    expect(checkpoint.statusCode).toBe(201);
    expect(checkpoint.json()).toMatchObject({
      communityId: community.id,
      actorType: 'account',
      actorId: owner.id,
      sequence: 2,
    });
    const hold = await app.inject({
      method: 'POST',
      url: `/v1/communities/${community.id}/audit-events/legal-hold`,
      payload: {
        actorId: owner.id,
        held: true,
        reasonCode: 'litigation_hold',
      },
    });
    expect(hold.statusCode).toBe(201);
    expect(hold.json()).toMatchObject({
      action: 'audit.legal_hold.apply',
      reasonCode: 'litigation_hold',
      targetType: 'community',
      targetId: community.id,
    });
    const retention = await app.inject(
      `/v1/communities/${community.id}/audit-events/retention?actorId=${owner.id}`,
    );
    expect(retention.statusCode).toBe(200);
    expect(retention.json()).toEqual({
      policy: 'security_7y',
      legalHold: true,
      eligibleThroughSequence: 0,
    });
    const exported = await app.inject(
      `/v1/communities/${community.id}/audit-events/export?actorId=${owner.id}&limit=1`,
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('application/x-ndjson');
    expect(JSON.parse(exported.body.trim())).toMatchObject({
      actorId: owner.id,
      scopeId: community.id,
    });
    expect(exported.body).not.toContain('token');
    expect(exported.body).not.toContain('password');
    expect(exported.body).not.toContain('address');
    expect(app.requestRateLimiter).toBeDefined();

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
