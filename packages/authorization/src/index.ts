import { randomUUID } from 'node:crypto';

export const permissionCatalog = [
  'community.view',
  'community.manage',
  'community.transfer',
  'membership.view',
  'membership.manage',
  'category.view',
  'category.manage',
  'space.view',
  'space.manage',
  'message.create',
  'message.manage',
  'invitation.create',
  'invitation.manage',
  'moderation.ban',
  'moderation.audit',
] as const;
export type Permission = (typeof permissionCatalog)[number];
export type ScopeType =
  | 'instance'
  | 'community'
  | 'category'
  | 'space'
  | 'resource';
export interface Scope {
  type: ScopeType;
  id: string;
}
export interface ScopedDecision {
  roleId: string;
  permission: Permission;
  scope: Scope;
  effect: 'grant' | 'deny';
}
export interface Role {
  id: string;
  communityId: string | null;
  name: string;
  position: number;
  protected: boolean;
  version: number;
}
export interface RoleAssignment {
  roleId: string;
  actorId: string;
  communityId: string;
  version: number;
}
export interface ActorState {
  actorId: string;
  sessionValid: boolean;
  sessionRevoked?: boolean;
  suspended: boolean;
  ownerOf?: string[];
}
export interface EvaluationInput {
  actor: ActorState;
  permission: Permission;
  scopes: readonly Scope[];
  roles: readonly Role[];
  assignments: readonly RoleAssignment[];
  decisions: readonly ScopedDecision[];
}
export interface DecisionMetadata {
  allowed: boolean;
  permission: Permission;
  reason: 'owner' | 'grant' | 'deny' | 'missing_grant' | 'invalid_actor';
  scope?: Scope;
}

const specificity: Record<ScopeType, number> = {
  instance: 0,
  community: 1,
  category: 2,
  space: 3,
  resource: 4,
};

export function evaluatePermission(input: EvaluationInput): DecisionMetadata {
  if (
    !input.actor.sessionValid ||
    input.actor.sessionRevoked ||
    input.actor.suspended
  )
    return {
      allowed: false,
      permission: input.permission,
      reason: 'invalid_actor',
    };
  const community = input.scopes.find((scope) => scope.type === 'community');
  if (community && input.actor.ownerOf?.includes(community.id))
    return {
      allowed: true,
      permission: input.permission,
      reason: 'owner',
      scope: community,
    };
  const scopeKeys = new Set(input.scopes.map(scopeKey));
  const assigned = new Set(
    input.assignments
      .filter((assignment) => assignment.actorId === input.actor.actorId)
      .map((assignment) => assignment.roleId),
  );
  const applicable = input.decisions
    .filter(
      (decision) =>
        assigned.has(decision.roleId) &&
        decision.permission === input.permission &&
        scopeKeys.has(scopeKey(decision.scope)),
    )
    .sort(
      (left, right) =>
        specificity[right.scope.type] - specificity[left.scope.type] ||
        (left.effect === 'deny' ? -1 : 1),
    );
  const selected = applicable[0];
  if (!selected)
    return {
      allowed: false,
      permission: input.permission,
      reason: 'missing_grant',
    };
  return {
    allowed: selected.effect === 'grant',
    permission: input.permission,
    reason: selected.effect,
    scope: selected.scope,
  };
}

export class AuthorizationError extends Error {
  readonly publicCode = 'not_found';
  constructor(readonly reason: DecisionMetadata['reason']) {
    super('authorization denied');
  }
}

export interface AuthorizationSnapshot {
  actor: ActorState;
  roles: Role[];
  assignments: RoleAssignment[];
  decisions: ScopedDecision[];
}
export interface AuthorizationStore {
  snapshot(
    actorId: string,
    scopes: readonly Scope[],
  ): Promise<AuthorizationSnapshot>;
  transaction<T>(work: (store: AuthorizationStore) => Promise<T>): Promise<T>;
  putRole(role: Role, expectedVersion?: number): Promise<Role>;
  assignRole(assignment: RoleAssignment): Promise<RoleAssignment>;
  putDecision(decision: ScopedDecision): Promise<ScopedDecision>;
  transferOwnership(
    communityId: string,
    currentOwnerId: string,
    nextOwnerId: string,
  ): Promise<void>;
}

export class AuthorizationService {
  constructor(private readonly store: AuthorizationStore) {}
  async preview(
    actorId: string,
    permission: Permission,
    scopes: readonly Scope[],
  ): Promise<DecisionMetadata> {
    return evaluatePermission({
      ...(await this.store.snapshot(actorId, scopes)),
      permission,
      scopes,
    });
  }
  async enforce(
    actorId: string,
    permission: Permission,
    scopes: readonly Scope[],
  ): Promise<DecisionMetadata> {
    const result = await this.preview(actorId, permission, scopes);
    if (!result.allowed) throw new AuthorizationError(result.reason);
    return result;
  }
  async setDecision(
    actorId: string,
    decision: ScopedDecision,
  ): Promise<ScopedDecision> {
    return this.store.transaction(async (store) => {
      const scopes = [decision.scope];
      const snapshot = await store.snapshot(actorId, scopes);
      const authority = evaluatePermission({
        ...snapshot,
        permission: decision.permission,
        scopes,
      });
      if (!authority.allowed) throw new AuthorizationError(authority.reason);
      return store.putDecision(decision);
    });
  }
  async updateRole(
    actorId: string,
    role: Role,
    expectedVersion?: number,
  ): Promise<Role> {
    return this.store.transaction(async (store) => {
      const scope = {
        type: 'community' as const,
        id: role.communityId ?? 'instance',
      };
      const snapshot = await store.snapshot(actorId, [scope]);
      const actorPositions = snapshot.roles
        .filter((candidate) =>
          snapshot.assignments.some(
            (a) => a.actorId === actorId && a.roleId === candidate.id,
          ),
        )
        .map((candidate) => candidate.position);
      const highest = Math.max(-1, ...actorPositions);
      if (role.protected && role.position >= highest)
        throw new AuthorizationError('deny');
      const authority = evaluatePermission({
        ...snapshot,
        permission: 'membership.manage',
        scopes: [scope],
      });
      if (!authority.allowed) throw new AuthorizationError(authority.reason);
      return store.putRole(role, expectedVersion);
    });
  }
  transferOwnership(
    actorId: string,
    communityId: string,
    nextOwnerId: string,
  ): Promise<void> {
    return this.store.transaction(async (store) => {
      const scope = [{ type: 'community' as const, id: communityId }];
      const snapshot = await store.snapshot(actorId, scope);
      const allowed = evaluatePermission({
        ...snapshot,
        permission: 'community.transfer',
        scopes: scope,
      });
      if (!allowed.allowed || !snapshot.actor.ownerOf?.includes(communityId))
        throw new AuthorizationError(allowed.reason);
      await store.transferOwnership(communityId, actorId, nextOwnerId);
    });
  }
}

export class StaleAuthorizationWriteError extends Error {}
export class InMemoryAuthorizationStore implements AuthorizationStore {
  actor: ActorState = {
    actorId: '',
    sessionValid: true,
    suspended: false,
    ownerOf: [],
  };
  roles: Role[] = [];
  assignments: RoleAssignment[] = [];
  decisions: ScopedDecision[] = [];
  /* eslint-disable @typescript-eslint/require-await -- async parity with storage port */
  async snapshot(actorId: string): Promise<AuthorizationSnapshot> {
    return {
      actor: { ...this.actor, actorId },
      roles: [...this.roles],
      assignments: [...this.assignments],
      decisions: [...this.decisions],
    };
  }
  async transaction<T>(
    work: (store: AuthorizationStore) => Promise<T>,
  ): Promise<T> {
    const before = structuredClone({
      actor: this.actor,
      roles: this.roles,
      assignments: this.assignments,
      decisions: this.decisions,
    });
    try {
      return await work(this);
    } catch (error) {
      Object.assign(this, before);
      throw error;
    }
  }
  async putRole(role: Role, expectedVersion?: number): Promise<Role> {
    const existing = this.roles.find((candidate) => candidate.id === role.id);
    if (
      existing &&
      expectedVersion !== undefined &&
      existing.version !== expectedVersion
    )
      throw new StaleAuthorizationWriteError();
    const saved = {
      ...role,
      id: role.id || randomUUID(),
      version: (existing?.version ?? 0) + 1,
    };
    this.roles = [
      ...this.roles.filter((candidate) => candidate.id !== saved.id),
      saved,
    ];
    return saved;
  }
  async assignRole(assignment: RoleAssignment): Promise<RoleAssignment> {
    const existing = this.assignments.find(
      (candidate) =>
        candidate.roleId === assignment.roleId &&
        candidate.actorId === assignment.actorId,
    );
    if (existing) return existing;
    this.assignments.push(assignment);
    return assignment;
  }
  async putDecision(decision: ScopedDecision): Promise<ScopedDecision> {
    const key = `${decision.roleId}:${decision.permission}:${scopeKey(decision.scope)}`;
    this.decisions = [
      ...this.decisions.filter(
        (candidate) =>
          `${candidate.roleId}:${candidate.permission}:${scopeKey(candidate.scope)}` !==
          key,
      ),
      decision,
    ];
    return decision;
  }
  async transferOwnership(
    communityId: string,
    currentOwnerId: string,
    nextOwnerId: string,
  ): Promise<void> {
    if (
      !this.actor.ownerOf?.includes(communityId) ||
      (this.actor.actorId && this.actor.actorId !== currentOwnerId)
    )
      throw new StaleAuthorizationWriteError();
    this.actor = {
      ...this.actor,
      actorId: nextOwnerId,
      ownerOf: [communityId],
    };
  }
  /* eslint-enable @typescript-eslint/require-await */
}

function scopeKey(scope: Scope): string {
  return `${scope.type}:${scope.id}`;
}
