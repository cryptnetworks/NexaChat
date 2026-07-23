import { describe, expect, it, vi } from 'vitest';
import { CommunityService, InMemoryPersistence } from '@nexa/domain';
import { realtimeEnvelopeSchema } from '@nexa/realtime-contracts';
import { buildApp } from '../src/app.js';

describe('message lifecycle HTTP boundary', () => {
  it('creates, retries, lists, edits, tombstones, and emits validated events', async () => {
    const service = new CommunityService(new InMemoryPersistence());
    const owner = await service.createAccount('Owner');
    const community = await service.createCommunity(owner.id, 'Community');
    const space = await service.createTextSpace(
      community.id,
      owner.id,
      'messages',
    );
    const app = buildApp(service);
    const broadcast = vi.fn();
    app.websocketHub = {
      broadcast,
      broadcastAccount: vi.fn(),
      ready: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };

    const payload = {
      authorId: owner.id,
      body: 'hello',
      idempotencyKey: 'request-http-0001',
    };
    const created = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${space.id}/messages`,
      payload,
    });
    expect(created.statusCode).toBe(201);
    const message = created.json<{ id: string; version: number }>();
    const retried = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${space.id}/messages`,
      payload,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.headers['idempotent-replayed']).toBe('true');
    expect(retried.json<{ id: string }>().id).toBe(message.id);

    const history = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${space.id}/messages?actorId=${owner.id}&limit=1`,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ items: [{ id: message.id }] });

    const edited = await app.inject({
      method: 'PATCH',
      url: `/v1/messages/${message.id}`,
      payload: {
        actorId: owner.id,
        body: 'edited',
        expectedVersion: message.version,
      },
    });
    expect(edited.statusCode).toBe(200);
    const updated = edited.json<{ version: number }>();
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/messages/${message.id}`,
      payload: { actorId: owner.id, expectedVersion: updated.version },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ body: null, version: 3 });

    const eventTypes = broadcast.mock.calls.map((call) => {
      const parsed = realtimeEnvelopeSchema.parse(call[1]);
      return parsed.type;
    });
    expect(eventTypes).toEqual([
      'message.created',
      'message.updated',
      'message.deleted',
    ]);
    await app.close();
  });

  it('returns stable private-resource and validation errors', async () => {
    const service = new CommunityService(new InMemoryPersistence());
    const owner = await service.createAccount('Owner');
    const outsider = await service.createAccount('Outsider');
    const community = await service.createCommunity(owner.id, 'Community');
    const space = await service.createTextSpace(community.id, owner.id, 'chat');
    const app = buildApp(service);
    const hidden = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${space.id}/messages?actorId=${outsider.id}&limit=10`,
    });
    expect(hidden.statusCode).toBe(403);
    const invalid = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${space.id}/messages`,
      payload: { authorId: owner.id, body: '', idempotencyKey: 'short' },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it('returns one creation and one replay for concurrent duplicate requests', async () => {
    const service = new CommunityService(new InMemoryPersistence());
    const owner = await service.createAccount('Owner');
    const community = await service.createCommunity(owner.id, 'Community');
    const space = await service.createTextSpace(community.id, owner.id, 'chat');
    const app = buildApp(service);
    const broadcast = vi.fn();
    app.websocketHub = {
      broadcast,
      broadcastAccount: vi.fn(),
      ready: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const request = {
      method: 'POST' as const,
      url: `/v1/spaces/${space.id}/messages`,
      payload: {
        authorId: owner.id,
        body: 'same',
        idempotencyKey: 'request-http-concurrent-0001',
      },
    };

    const responses = await Promise.all([
      app.inject(request),
      app.inject(request),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 201,
    ]);
    expect(
      new Set(responses.map((response) => response.json<{ id: string }>().id))
        .size,
    ).toBe(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
