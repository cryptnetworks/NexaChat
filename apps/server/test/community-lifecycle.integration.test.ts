import { describe, expect, it } from 'vitest';
import { AuthorizationError } from '@nexa/authorization';
import {
  CommunityService,
  InMemoryPersistence,
  type AuthorizationGateway,
} from '@nexa/domain';
import { buildApp } from '../src/app.js';

describe('community lifecycle HTTP boundary', () => {
  it('serves lifecycle, pagination, conflict, stale, archival, and validation behavior', async () => {
    const persistence = new InMemoryPersistence();
    const service = new CommunityService(persistence);
    const owner = await service.createAccount('Owner');
    const app = buildApp(service);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/communities',
      payload: { ownerId: owner.id, name: ' Core  Team ' },
    });
    expect(created.statusCode).toBe(201);
    const community = created.json<{
      id: string;
      version: number;
      name: string;
    }>();
    expect(community).toMatchObject({ name: 'Core Team', version: 1 });

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/communities?actorId=${owner.id}&limit=1`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ items: [{ id: community.id }] });

    const categoryResponse = await app.inject({
      method: 'POST',
      url: `/v1/communities/${community.id}/categories`,
      payload: { actorId: owner.id, name: ' General ' },
    });
    expect(categoryResponse.statusCode).toBe(201);
    const category = categoryResponse.json<{ id: string; version: number }>();
    const duplicate = await app.inject({
      method: 'POST',
      url: `/v1/communities/${community.id}/categories`,
      payload: { actorId: owner.id, name: 'general' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: 'conflict' });

    const spaceResponse = await app.inject({
      method: 'POST',
      url: `/v1/communities/${community.id}/spaces`,
      payload: {
        actorId: owner.id,
        name: 'chat',
        categoryId: category.id,
      },
    });
    expect(spaceResponse.statusCode).toBe(201);
    const space = spaceResponse.json<{ id: string; version: number }>();
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/v1/spaces/${space.id}`,
      payload: {
        actorId: owner.id,
        name: 'renamed',
        expectedVersion: space.version,
      },
    });
    expect(renamed.statusCode).toBe(200);
    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/spaces/${space.id}`,
      payload: {
        actorId: owner.id,
        name: 'stale',
        expectedVersion: space.version,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'stale_write' });

    const archived = await app.inject({
      method: 'PATCH',
      url: `/v1/categories/${category.id}`,
      payload: {
        actorId: owner.id,
        archived: true,
        expectedVersion: category.version,
      },
    });
    expect(archived.statusCode).toBe(200);
    const categories = await app.inject({
      method: 'GET',
      url: `/v1/communities/${community.id}/categories?actorId=${owner.id}`,
    });
    expect(categories.json()).toEqual([]);

    const invalidPage = await app.inject({
      method: 'GET',
      url: `/v1/communities?actorId=${owner.id}&limit=101`,
    });
    expect(invalidPage.statusCode).toBe(400);
    expect(invalidPage.json()).toMatchObject({ error: 'invalid_request' });
    await app.close();
  });

  it('does not disclose private resources after authorization denial', async () => {
    const persistence = new InMemoryPersistence();
    const allow: AuthorizationGateway = {
      enforce: () => Promise.resolve(),
    };
    const setup = new CommunityService(persistence, allow);
    const owner = await setup.createAccount('Owner');
    const outsider = await setup.createAccount('Outsider');
    const community = await setup.createCommunity(owner.id, 'Private');
    const deny: AuthorizationGateway = {
      enforce: () => Promise.reject(new AuthorizationError('missing_grant')),
    };
    const app = buildApp(new CommunityService(persistence, deny));
    const response = await app.inject({
      method: 'GET',
      url: `/v1/communities/${community.id}?actorId=${outsider.id}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not_found' });
    await app.close();
  });
});
