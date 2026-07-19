import { describe, expect, it, vi } from 'vitest';
import {
  FixedWindowInvitationRateLimiter,
  InMemoryCommunityService,
  InMemoryPersistence,
} from '@nexa/domain';
import { buildApp } from '../src/app.js';

describe('invitation HTTP lifecycle', () => {
  it('creates, lists, previews, accepts idempotently, revokes, and never exposes protected tokens', async () => {
    const { app, service, owner, member, community } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: `/v1/communities/${community.id}/invitations`,
      payload: {
        actorId: owner.id,
        expiresInSeconds: 600,
        maxUses: 2,
        targetAccountId: member.id,
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{
      token: string;
      invitation: { id: string; version: number };
    }>();
    expect(body.token).toHaveLength(43);
    expect(JSON.stringify(body.invitation)).not.toContain('token');

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/communities/${community.id}/invitations?actorId=${owner.id}`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(body.token);
    expect(listed.body).not.toContain('tokenHash');

    const preview = await app.inject({
      method: 'POST',
      url: '/v1/invitations/preview',
      payload: { actorId: member.id, token: body.token },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual(
      expect.objectContaining({
        communityId: community.id,
        communityName: community.name,
      }),
    );

    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { actorId: member.id, token: body.token },
    });
    expect(accepted.statusCode).toBe(200);
    const retry = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { actorId: member.id, token: body.token },
    });
    expect(retry.json()).toEqual(accepted.json());

    const stored = await service.persistence.invitations.findById(
      body.invitation.id,
    );
    if (!stored) throw new Error('missing invitation');
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/invitations/${stored.id}`,
      payload: { actorId: owner.id, expectedVersion: stored.version },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ id: stored.id });
    await app.close();
  });

  it('uses generic failures for malformed, private, revoked, and exhausted invitations', async () => {
    const { app, owner, member, outsider, community } = await fixture();
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { actorId: member.id, token: 'bad' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: 'invalid_request' });

    const created = await app.inject({
      method: 'POST',
      url: `/v1/communities/${community.id}/invitations`,
      payload: {
        actorId: owner.id,
        expiresInSeconds: 600,
        maxUses: 1,
        targetAccountId: member.id,
      },
    });
    const invite = created.json<{
      token: string;
      invitation: { id: string; version: number };
    }>();
    const privatePreview = await app.inject({
      method: 'POST',
      url: '/v1/invitations/preview',
      payload: { actorId: outsider.id, token: invite.token },
    });
    expect(privatePreview.statusCode).toBe(404);
    expect(privatePreview.json()).toMatchObject({
      error: 'invitation_unavailable',
    });
    await app.inject({
      method: 'DELETE',
      url: `/v1/invitations/${invite.invitation.id}`,
      payload: {
        actorId: owner.id,
        expectedVersion: invite.invitation.version,
      },
    });
    const revoked = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { actorId: member.id, token: invite.token },
    });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.json()).toMatchObject({
      error: 'invitation_unavailable',
    });
    await app.close();
  });

  it('allows one concurrent final-use acceptance and rejects unauthorized administration', async () => {
    const { app, owner, member, outsider, community } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: `/v1/communities/${community.id}/invitations`,
      payload: {
        actorId: owner.id,
        expiresInSeconds: 600,
        maxUses: 1,
      },
    });
    const token = created.json<{ token: string }>().token;
    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        payload: { actorId: member.id, token },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        payload: { actorId: outsider.id, token },
      }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 404,
    ]);
    const denied = await app.inject({
      method: 'POST',
      url: `/v1/communities/${community.id}/invitations`,
      payload: {
        actorId: outsider.id,
        expiresInSeconds: 600,
        maxUses: 1,
      },
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it('redacts invite secrets from structured request logs', async () => {
    const logs: string[] = [];
    const service = new InMemoryCommunityService();
    const auth = {
      service: {
        authenticate: vi.fn().mockRejectedValue(new Error('unused')),
      },
      config: {
        trustedOrigin: 'http://web.test',
        secureCookies: false,
        cookieMaxAgeSeconds: 60,
      },
      logStream: { write: (message: string) => logs.push(message) },
    };
    const app = buildApp(service, undefined, auth as never);
    const secret = 'S'.repeat(43);
    await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { actorId: crypto.randomUUID(), token: secret },
    });
    expect(logs.join('')).not.toContain(secret);
    await app.close();
  });
});

async function fixture() {
  const persistence = new InMemoryPersistence();
  let counter = 0;
  const service = new InMemoryCommunityService(
    persistence,
    undefined,
    new FixedWindowInvitationRateLimiter(100, 60_000),
    () => String(counter++).padStart(43, 'A').slice(-43),
  );
  const owner = await service.createAccount('Owner');
  const member = await service.createAccount('Member');
  const outsider = await service.createAccount('Outsider');
  const community = await service.createCommunity(owner.id, 'Community');
  return {
    app: buildApp(service),
    service,
    owner,
    member,
    outsider,
    community,
  };
}
