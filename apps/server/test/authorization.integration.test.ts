import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthorizationService,
  InMemoryAuthorizationStore,
} from '@nexa/authorization';
import { CommunityService, InMemoryPersistence } from '@nexa/domain';
import { buildApp } from '../src/app.js';

const ids = {
  owner: '00000000-0000-4000-8000-000000000001',
  member: '00000000-0000-4000-8000-000000000002',
};
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe('authorization service boundaries', () => {
  it('enforces space creation, message creation, and preview through one evaluator', async () => {
    const persistence = new InMemoryPersistence();
    await persistence.accounts.create({ id: ids.owner, displayName: 'Owner' });
    await persistence.accounts.create({
      id: ids.member,
      displayName: 'Member',
    });
    const bootstrap = new CommunityService(persistence);
    const community = await bootstrap.createCommunity(ids.owner, 'Community');
    const store = new InMemoryAuthorizationStore();
    store.actor = {
      actorId: ids.owner,
      sessionValid: true,
      suspended: false,
      ownerOf: [community.id],
    };
    const authorization = new AuthorizationService(store);
    const app = buildApp(
      new CommunityService(persistence, authorization),
      undefined,
      undefined,
      authorization,
    );
    apps.push(app);

    const preview = await app.inject({
      method: 'POST',
      url: '/v1/permissions/preview',
      payload: {
        actorId: ids.owner,
        permission: 'space.manage',
        scopes: [{ type: 'community', id: community.id }],
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ allowed: true, reason: 'owner' });

    const created = await app.inject({
      method: 'POST',
      url: `/v1/communities/${community.id}/spaces`,
      payload: { actorId: ids.owner, name: 'General' },
    });
    expect(created.statusCode).toBe(201);
    const spaceId = created.json<{ id: string }>().id;
    const message = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${spaceId}/messages`,
      payload: { authorId: ids.owner, body: 'hello' },
    });
    expect(message.statusCode).toBe(201);
  });

  it('does not disclose whether a private resource exists', async () => {
    const persistence = new InMemoryPersistence();
    await persistence.accounts.create({ id: ids.owner, displayName: 'Owner' });
    await persistence.accounts.create({
      id: ids.member,
      displayName: 'Member',
    });
    const bootstrap = new CommunityService(persistence);
    const community = await bootstrap.createCommunity(ids.owner, 'Private');
    const space = await bootstrap.createTextSpace(
      community.id,
      ids.owner,
      'Secret',
    );
    const store = new InMemoryAuthorizationStore();
    store.actor = { actorId: ids.member, sessionValid: true, suspended: false };
    const authorization = new AuthorizationService(store);
    const app = buildApp(
      new CommunityService(persistence, authorization),
      undefined,
      undefined,
      authorization,
    );
    apps.push(app);
    const privateResponse = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${space.id}/messages`,
      payload: { authorId: ids.member, body: 'probe' },
    });
    const missingResponse = await app.inject({
      method: 'POST',
      url: '/v1/spaces/00000000-0000-4000-8000-000000000099/messages',
      payload: { authorId: ids.member, body: 'probe' },
    });
    expect(privateResponse.statusCode).toBe(404);
    expect(privateResponse.json<{ error: string }>().error).toBe('not_found');
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json<{ error: string }>().error).toBe('not_found');
  });
});
