import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('HTTP vertical slice', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
    delete process.env.NEXA_ENABLE_DEV_AUTH;
  });

  it('completes the development flow', async () => {
    process.env.NODE_ENV = 'development';
    process.env.NEXA_ENABLE_DEV_AUTH = 'true';
    const app = buildApp();
    const account = await app.inject({
      method: 'POST',
      url: '/v1/dev/accounts',
      payload: { displayName: 'Mira' },
    });
    const owner = account.json<{ id: string }>();
    const community = await app.inject({
      method: 'POST',
      url: '/v1/communities',
      payload: { ownerId: owner.id, name: 'Workshop' },
    });
    const createdCommunity = community.json<{ id: string }>();
    const space = await app.inject({
      method: 'POST',
      url: `/v1/communities/${createdCommunity.id}/spaces`,
      payload: { actorId: owner.id, name: 'planning' },
    });
    const createdSpace = space.json<{ id: string }>();
    const message = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${createdSpace.id}/messages`,
      payload: { authorId: owner.id, body: 'Hello' },
    });
    expect([
      account.statusCode,
      community.statusCode,
      space.statusCode,
      message.statusCode,
    ]).toEqual([201, 201, 201, 201]);
    await app.close();
  });

  it('keeps development account creation disabled by default', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/dev/accounts',
      payload: { displayName: 'Mira' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it.each([
    { url: '/v1/dev/accounts', payload: { displayName: '' } },
    { url: '/v1/dev/accounts', payload: { displayName: 'Mira', extra: true } },
  ])('returns a stable error for invalid input', async ({ url, payload }) => {
    process.env.NODE_ENV = 'development';
    process.env.NEXA_ENABLE_DEV_AUTH = 'true';
    const app = buildApp();
    const response = await app.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
    expect(JSON.stringify(response.json())).not.toContain('displayName');
    await app.close();
  });

  it('returns the same stable error for malformed JSON', async () => {
    process.env.NODE_ENV = 'development';
    process.env.NEXA_ENABLE_DEV_AUTH = 'true';
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/dev/accounts',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
    await app.close();
  });
});
