import { describe, expect, it, vi } from 'vitest';
import {
  AuthorizationError,
  AuthorizationService,
  InMemoryAuthorizationStore,
  StaleAuthorizationWriteError,
  evaluatePermission,
  type EvaluationInput,
  type Scope,
} from '../src/index.js';

/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixed test fixtures */

const community: Scope = {
  type: 'community',
  id: '00000000-0000-4000-8000-000000000001',
};
const category: Scope = {
  type: 'category',
  id: '00000000-0000-4000-8000-000000000002',
};
const space: Scope = {
  type: 'space',
  id: '00000000-0000-4000-8000-000000000003',
};
const base: EvaluationInput = {
  actor: { actorId: 'actor', sessionValid: true, suspended: false },
  permission: 'space.view',
  scopes: [community, category, space],
  roles: [
    {
      id: 'role',
      communityId: community.id,
      name: 'member',
      position: 1,
      protected: false,
      version: 1,
    },
  ],
  assignments: [
    { roleId: 'role', actorId: 'actor', communityId: community.id, version: 1 },
  ],
  decisions: [],
};

describe('deny-by-default decision table', () => {
  it.each([
    ['missing grant', [], false, 'missing_grant'],
    [
      'direct grant',
      [
        {
          roleId: 'role',
          permission: 'space.view' as const,
          scope: space,
          effect: 'grant' as const,
        },
      ],
      true,
      'grant',
    ],
    [
      'direct denial',
      [
        {
          roleId: 'role',
          permission: 'space.view' as const,
          scope: space,
          effect: 'deny' as const,
        },
      ],
      false,
      'deny',
    ],
    [
      'inherited grant',
      [
        {
          roleId: 'role',
          permission: 'space.view' as const,
          scope: community,
          effect: 'grant' as const,
        },
      ],
      true,
      'grant',
    ],
    [
      'inherited denial',
      [
        {
          roleId: 'role',
          permission: 'space.view' as const,
          scope: category,
          effect: 'deny' as const,
        },
      ],
      false,
      'deny',
    ],
    [
      'narrow grant overrides broad denial',
      [
        {
          roleId: 'role',
          permission: 'space.view' as const,
          scope: community,
          effect: 'deny' as const,
        },
        {
          roleId: 'role',
          permission: 'space.view' as const,
          scope: space,
          effect: 'grant' as const,
        },
      ],
      true,
      'grant',
    ],
    [
      'narrow denial overrides broad grant',
      [
        {
          roleId: 'role',
          permission: 'space.view' as const,
          scope: community,
          effect: 'grant' as const,
        },
        {
          roleId: 'role',
          permission: 'space.view' as const,
          scope: space,
          effect: 'deny' as const,
        },
      ],
      false,
      'deny',
    ],
    [
      'equal scope deny wins',
      [
        {
          roleId: 'role',
          permission: 'space.view' as const,
          scope: space,
          effect: 'grant' as const,
        },
        {
          roleId: 'role',
          permission: 'space.view' as const,
          scope: space,
          effect: 'deny' as const,
        },
      ],
      false,
      'deny',
    ],
  ])('%s', (_name, decisions, allowed, reason) => {
    expect(evaluatePermission({ ...base, decisions })).toMatchObject({
      allowed,
      reason,
    });
  });

  it.each([
    ['suspended actor', { suspended: true }],
    ['invalid session', { sessionValid: false }],
    ['revoked session', { sessionRevoked: true }],
  ])('rejects %s before grants', (_name, state) => {
    expect(
      evaluatePermission({
        ...base,
        actor: { ...base.actor, ...state },
        decisions: [
          {
            roleId: 'role',
            permission: 'space.view',
            scope: space,
            effect: 'grant',
          },
        ],
      }),
    ).toMatchObject({ allowed: false, reason: 'invalid_actor' });
  });

  it('gives owners authority only in their community', () => {
    expect(
      evaluatePermission({
        ...base,
        actor: { ...base.actor, ownerOf: [community.id] },
      }),
    ).toMatchObject({ allowed: true, reason: 'owner' });
    expect(
      evaluatePermission({
        ...base,
        actor: { ...base.actor, ownerOf: ['another'] },
      }).allowed,
    ).toBe(false);
  });
});

describe('authorization mutations', () => {
  it('uses the same evaluator for preview and enforcement', async () => {
    const store = allowedStore();
    const service = new AuthorizationService(store);
    const preview = await service.preview('actor', 'space.view', [community]);
    await expect(
      service.enforce('actor', 'space.view', [community]),
    ).resolves.toEqual(preview);
  });

  it('observes bounded decisions without changing authorization behavior', async () => {
    const observer = {
      decision: vi.fn(() => {
        throw new Error('telemetry unavailable');
      }),
    };
    const store = allowedStore();
    store.assignments = store.assignments.map((assignment) => ({
      ...assignment,
      actorId: 'private-actor',
    }));
    const allowed = new AuthorizationService(store, observer);
    await expect(
      allowed.enforce('private-actor', 'space.view', [community]),
    ).resolves.toMatchObject({ allowed: true });
    expect(observer.decision).toHaveBeenLastCalledWith('space.view', 'allow');

    store.decisions = [];
    await expect(
      allowed.enforce('private-actor', 'space.view', [community]),
    ).rejects.toMatchObject({ observed: true });
    expect(observer.decision).toHaveBeenLastCalledWith('space.view', 'deny');
    expect(JSON.stringify(observer.decision.mock.calls)).not.toContain(
      'private-actor',
    );
    expect(JSON.stringify(observer.decision.mock.calls)).not.toContain(
      community.id,
    );
  });

  it('prevents unauthorized grants and rolls back', async () => {
    const store = new InMemoryAuthorizationStore();
    const service = new AuthorizationService(store);
    await expect(
      service.setDecision('actor', {
        roleId: 'role',
        permission: 'moderation.ban',
        scope: community,
        effect: 'grant',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(store.decisions).toEqual([]);
  });

  it('makes assignments and decisions idempotent', async () => {
    const store = allowedStore();
    const assignment = store.assignments[0]!;
    await store.assignRole(assignment);
    await store.assignRole(assignment);
    const decision = store.decisions[0]!;
    await store.putDecision(decision);
    await store.putDecision(decision);
    expect(store.assignments).toHaveLength(1);
    expect(store.decisions).toHaveLength(2);
  });

  it('rejects stale role writes', async () => {
    const store = allowedStore();
    const role = store.roles[0]!;
    await expect(store.putRole(role, 99)).rejects.toBeInstanceOf(
      StaleAuthorizationWriteError,
    );
  });

  it('prevents equal and higher protected-role modification', async () => {
    const store = allowedStore();
    const service = new AuthorizationService(store);
    store.roles.push({
      id: 'protected',
      communityId: community.id,
      name: 'admin',
      position: 10,
      protected: true,
      version: 1,
    });
    await expect(
      service.updateRole('actor', store.roles[1]!, 1),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('transfers sole ownership atomically and rejects concurrent stale transfer', async () => {
    const store = allowedStore();
    store.actor = {
      actorId: 'owner',
      sessionValid: true,
      suspended: false,
      ownerOf: [community.id],
    };
    const service = new AuthorizationService(store);
    await service.transferOwnership('owner', community.id, 'next');
    expect(store.actor).toMatchObject({
      actorId: 'next',
      ownerOf: [community.id],
    });
    await expect(
      service.transferOwnership('owner', community.id, 'other'),
    ).rejects.toBeInstanceOf(StaleAuthorizationWriteError);
  });
});

function allowedStore() {
  const store = new InMemoryAuthorizationStore();
  store.actor = { actorId: 'actor', sessionValid: true, suspended: false };
  store.roles = [...base.roles];
  store.assignments = [...base.assignments];
  store.decisions = [
    {
      roleId: 'role',
      permission: 'space.view',
      scope: community,
      effect: 'grant',
    },
    {
      roleId: 'role',
      permission: 'membership.manage',
      scope: community,
      effect: 'grant',
    },
  ];
  return store;
}
