import { createHash, randomBytes, randomUUID } from 'node:crypto';

export type MembershipStatus =
  'active' | 'invited' | 'left' | 'removed' | 'suspended';

export interface Account {
  id: string;
  displayName: string;
}
export interface Community {
  id: string;
  name: string;
  ownerId: string;
  archivedAt: string | null;
  version: number;
}
export interface Membership {
  id: string;
  communityId: string;
  accountId: string;
  status: MembershipStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface Category {
  id: string;
  communityId: string;
  name: string;
  position: number;
  archivedAt: string | null;
  version: number;
}
export interface Space {
  id: string;
  communityId: string;
  categoryId: string | null;
  name: string;
  kind: 'text';
  position: number;
  archivedAt: string | null;
  version: number;
}
export interface Message {
  id: string;
  spaceId: string;
  authorId: string;
  body: string | null;
  replyToId: string | null;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
}
export interface Invitation {
  id: string;
  communityId: string;
  creatorId: string;
  tokenHash: string;
  targetAccountId: string | null;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  useCount: number;
  revokedAt: string | null;
  version: number;
}
export interface AuditEvent {
  version: 1;
  actorType: 'account' | 'service';
  id: string;
  actorId: string;
  scopeType: 'community' | 'instance';
  scopeId: string | null;
  targetType: 'audit_chain' | 'community' | 'invitation' | 'none';
  targetId: string | null;
  action:
    | 'invitation.create'
    | 'invitation.revoke'
    | 'invitation.accept'
    | 'audit.checkpoint'
    | 'audit.legal_hold.apply'
    | 'audit.legal_hold.release';
  outcome: 'succeeded' | 'rejected';
  reasonCode: string | null;
  correlationId: string;
  occurredAt: string;
  retentionUntil: string;
  sequence: number;
  previousHash: string;
  eventHash: string;
}
export type AuditEventInput = Omit<
  AuditEvent,
  'eventHash' | 'previousHash' | 'sequence'
>;
export interface AuditIntegrity {
  valid: boolean;
  count: number;
  headHash: string | null;
  checkpointSequence: number | null;
  checkpointHash: string | null;
  checkpointValid: boolean;
}
export interface AuditCheckpoint {
  id: string;
  communityId: string;
  sequence: number;
  headHash: string;
  actorType: 'account' | 'service';
  actorId: string;
  correlationId: string;
  createdAt: string;
}
export interface AuditRetention {
  policy: 'security_7y';
  legalHold: boolean;
  eligibleThroughSequence: number;
}
export interface SessionRecord {
  id: string;
  accountId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface ListPage {
  limit: number;
  cursor?: string;
}

export interface Persistence {
  accounts: {
    create(account: Account): Promise<Account>;
    findById(id: string): Promise<Account | undefined>;
  };
  communities: {
    create(community: Community): Promise<Community>;
    findById(id: string): Promise<Community | undefined>;
    listVisible(accountId: string, page: ListPage): Promise<Page<Community>>;
    update(
      id: string,
      name: string,
      expectedVersion: number,
    ): Promise<Community | undefined>;
    archive(
      id: string,
      expectedVersion: number,
      archivedAt: string,
    ): Promise<Community | undefined>;
  };
  memberships: {
    create(membership: Membership): Promise<Membership>;
    findByCommunityAndAccount(
      communityId: string,
      accountId: string,
    ): Promise<Membership | undefined>;
    list(communityId: string): Promise<Membership[]>;
    updateStatus(
      id: string,
      status: MembershipStatus,
      expectedVersion: number,
      updatedAt: string,
    ): Promise<Membership | undefined>;
  };
  categories: {
    create(category: Category): Promise<Category>;
    findById(id: string): Promise<Category | undefined>;
    list(communityId: string, includeArchived?: boolean): Promise<Category[]>;
    update(
      id: string,
      input: Pick<Category, 'name' | 'position' | 'archivedAt'>,
      expectedVersion: number,
    ): Promise<Category | undefined>;
    remove(id: string): Promise<boolean>;
    rename(id: string, name: string): Promise<Category | undefined>;
  };
  spaces: {
    create(space: Space): Promise<Space>;
    findById(id: string): Promise<Space | undefined>;
    list(
      communityId: string,
      page: ListPage,
      includeArchived?: boolean,
    ): Promise<Page<Space>>;
    update(
      id: string,
      input: Pick<Space, 'name' | 'position' | 'categoryId' | 'archivedAt'>,
      expectedVersion: number,
    ): Promise<Space | undefined>;
    remove(id: string): Promise<boolean>;
    rename(id: string, name: string): Promise<Space | undefined>;
  };
  messages: {
    create(message: Message): Promise<Message>;
    findById(id: string): Promise<Message | undefined>;
    findByIdempotencyKey(
      authorId: string,
      spaceId: string,
      key: string,
    ): Promise<Message | undefined>;
    list(spaceId: string, page: ListPage): Promise<Page<Message>>;
    update(
      id: string,
      body: string,
      expectedVersion: number,
      updatedAt: string,
    ): Promise<Message | undefined>;
    tombstone(
      id: string,
      expectedVersion: number,
      deletedAt: string,
    ): Promise<Message | undefined>;
    remove(id: string): Promise<boolean>;
  };
  invitations: {
    create(invitation: Invitation): Promise<Invitation>;
    findById(id: string): Promise<Invitation | undefined>;
    findByTokenHash(tokenHash: string): Promise<Invitation | undefined>;
    list(communityId: string): Promise<Invitation[]>;
    claim(
      id: string,
      expectedVersion: number,
      acceptedAt: string,
    ): Promise<Invitation | undefined>;
    revoke(
      id: string,
      expectedVersion: number,
      revokedAt: string,
    ): Promise<Invitation | undefined>;
  };
  auditEvents: {
    create(event: AuditEventInput): Promise<AuditEvent>;
    list(communityId: string, page: ListPage): Promise<Page<AuditEvent>>;
    verify(communityId: string): Promise<AuditIntegrity>;
    checkpoint(checkpoint: AuditCheckpoint): Promise<AuditCheckpoint>;
    retention(communityId: string, now: string): Promise<AuditRetention>;
  };
  sessions: {
    create(session: SessionRecord): Promise<SessionRecord>;
    findByTokenHash(tokenHash: string): Promise<SessionRecord | undefined>;
    revoke(id: string, revokedAt: string): Promise<boolean>;
  };
  transaction<T>(work: (persistence: Persistence) => Promise<T>): Promise<T>;
}

export class DomainError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'forbidden'
      | 'conflict'
      | 'stale_write'
      | 'sole_owner'
      | 'rate_limited'
      | 'invitation_unavailable',
  ) {
    super(code);
  }
}
export interface AuthorizationGateway {
  enforce(
    actorId: string,
    permission:
      | 'community.view'
      | 'community.manage'
      | 'membership.view'
      | 'membership.manage'
      | 'category.view'
      | 'category.manage'
      | 'space.manage'
      | 'message.create'
      | 'message.manage'
      | 'space.view'
      | 'invitation.create'
      | 'invitation.manage'
      | 'moderation.audit',
    scopes: readonly { type: 'community' | 'category' | 'space'; id: string }[],
  ): Promise<unknown>;
}

const normalizeName = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').normalize('NFKC');
function name(value: string): string {
  const normalized = normalizeName(value);
  if (!normalized || normalized.length > 80) throw new DomainError('conflict');
  return normalized;
}
function page(input: ListPage): ListPage {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new DomainError('conflict');
  return input;
}
function position(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new DomainError('conflict');
  return value;
}
function messageBody(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (!normalized || normalized.length > 4000)
    throw new DomainError('conflict');
  return normalized;
}
function idempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized))
    throw new DomainError('conflict');
  return normalized;
}

export interface InvitationRateLimiter {
  consume(key: string, now: Date): Promise<boolean>;
}

export class FixedWindowInvitationRateLimiter implements InvitationRateLimiter {
  private readonly buckets = new Map<
    string,
    { count: number; startedAt: number }
  >();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  consume(key: string, now: Date): Promise<boolean> {
    const timestamp = now.getTime();
    const current = this.buckets.get(key);
    const bucket =
      !current || timestamp - current.startedAt >= this.windowMs
        ? { count: 0, startedAt: timestamp }
        : current;
    if (bucket.count >= this.limit) return Promise.resolve(false);
    this.buckets.set(key, { ...bucket, count: bucket.count + 1 });
    return Promise.resolve(true);
  }
}

export function protectInvitationToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new DomainError('invitation_unavailable');
  return createHash('sha256').update(token).digest('hex');
}

export const zeroAuditHash = '0'.repeat(64);

export function auditEventHash(
  previousHash: string,
  event: AuditEventInput,
): string {
  return createHash('sha256')
    .update(
      [
        previousHash,
        event.version,
        event.id,
        event.actorType,
        event.actorId,
        event.scopeType,
        event.scopeId ?? '',
        event.targetType,
        event.targetId ?? '',
        event.action,
        event.outcome,
        event.reasonCode ?? '',
        event.correlationId,
        event.retentionUntil,
        event.occurredAt,
      ].join('|'),
    )
    .digest('hex');
}

export class CommunityService {
  constructor(
    public readonly persistence: Persistence,
    private readonly authorization?: AuthorizationGateway,
    private readonly invitationLimiter: InvitationRateLimiter = new FixedWindowInvitationRateLimiter(
      20,
      60_000,
    ),
    private readonly issueInvitationToken: () => string = () =>
      randomBytes(32).toString('base64url'),
  ) {}
  createAccount(displayName: string): Promise<Account> {
    return this.persistence.accounts.create({
      id: randomUUID(),
      displayName: name(displayName),
    });
  }

  async createCommunity(ownerId: string, value: string): Promise<Community> {
    if (!(await this.persistence.accounts.findById(ownerId)))
      throw new DomainError('not_found');
    return this.persistence.transaction(async (persistence) => {
      const community = await persistence.communities.create({
        id: randomUUID(),
        ownerId,
        name: name(value),
        archivedAt: null,
        version: 1,
      });
      const now = new Date().toISOString();
      await persistence.memberships.create({
        id: randomUUID(),
        communityId: community.id,
        accountId: ownerId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
      return community;
    });
  }

  async listCommunities(
    actorId: string,
    input: ListPage,
  ): Promise<Page<Community>> {
    return this.persistence.communities.listVisible(actorId, page(input));
  }
  async getCommunity(actorId: string, id: string): Promise<Community> {
    const community = await this.community(id);
    await this.enforce(actorId, 'community.view', [{ type: 'community', id }]);
    return community;
  }
  async updateCommunity(
    actorId: string,
    id: string,
    value: string,
    expectedVersion: number,
  ): Promise<Community> {
    await this.community(id);
    await this.enforce(actorId, 'community.manage', [
      { type: 'community', id },
    ]);
    return this.saved(
      await this.persistence.communities.update(
        id,
        name(value),
        expectedVersion,
      ),
    );
  }
  async archiveCommunity(
    actorId: string,
    id: string,
    expectedVersion: number,
  ): Promise<Community> {
    await this.community(id);
    await this.enforce(actorId, 'community.manage', [
      { type: 'community', id },
    ]);
    return this.saved(
      await this.persistence.communities.archive(
        id,
        expectedVersion,
        new Date().toISOString(),
      ),
    );
  }

  async changeMembership(
    actorId: string,
    communityId: string,
    accountId: string,
    status: MembershipStatus,
    expectedVersion?: number,
  ): Promise<Membership> {
    const community = await this.community(communityId);
    const existing =
      await this.persistence.memberships.findByCommunityAndAccount(
        communityId,
        accountId,
      );
    if (actorId === accountId && status === 'left')
      await this.enforce(actorId, 'membership.view', [
        { type: 'community', id: communityId },
      ]);
    else
      await this.enforce(actorId, 'membership.manage', [
        { type: 'community', id: communityId },
      ]);
    if (community.ownerId === accountId && status !== 'active')
      throw new DomainError('sole_owner');
    const now = new Date().toISOString();
    if (!existing) {
      if (!(await this.persistence.accounts.findById(accountId)))
        throw new DomainError('not_found');
      return this.persistence.memberships.create({
        id: randomUUID(),
        communityId,
        accountId,
        status,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
    }
    return this.saved(
      await this.persistence.memberships.updateStatus(
        existing.id,
        status,
        expectedVersion ?? existing.version,
        now,
      ),
    );
  }
  async listMemberships(
    actorId: string,
    communityId: string,
  ): Promise<Membership[]> {
    await this.community(communityId);
    await this.enforce(actorId, 'membership.view', [
      { type: 'community', id: communityId },
    ]);
    return this.persistence.memberships.list(communityId);
  }

  async createCategory(
    actorId: string,
    communityId: string,
    value: string,
  ): Promise<Category> {
    await this.community(communityId);
    await this.enforce(actorId, 'category.manage', [
      { type: 'community', id: communityId },
    ]);
    const position = (await this.persistence.categories.list(communityId))
      .length;
    return this.persistence.categories.create({
      id: randomUUID(),
      communityId,
      name: name(value),
      position,
      archivedAt: null,
      version: 1,
    });
  }
  async listCategories(
    actorId: string,
    communityId: string,
  ): Promise<Category[]> {
    await this.community(communityId);
    await this.enforce(actorId, 'category.view', [
      { type: 'community', id: communityId },
    ]);
    return this.persistence.categories.list(communityId);
  }
  async updateCategory(
    actorId: string,
    id: string,
    input: {
      name?: string | undefined;
      position?: number | undefined;
      archived?: boolean | undefined;
      expectedVersion: number;
    },
  ): Promise<Category> {
    const current = await this.persistence.categories.findById(id);
    if (!current) throw new DomainError('not_found');
    await this.enforce(actorId, 'category.manage', [
      { type: 'community', id: current.communityId },
      { type: 'category', id },
    ]);
    return this.saved(
      await this.persistence.categories.update(
        id,
        {
          name: input.name === undefined ? current.name : name(input.name),
          position:
            input.position === undefined
              ? current.position
              : position(input.position),
          archivedAt: input.archived
            ? new Date().toISOString()
            : current.archivedAt,
        },
        input.expectedVersion,
      ),
    );
  }

  async createTextSpace(
    communityId: string,
    actorId: string,
    value: string,
    categoryId: string | null = null,
  ): Promise<Space> {
    await this.community(communityId);
    await this.enforce(actorId, 'space.manage', [
      { type: 'community', id: communityId },
    ]);
    if (categoryId) {
      const category = await this.persistence.categories.findById(categoryId);
      if (
        !category ||
        category.communityId !== communityId ||
        category.archivedAt
      )
        throw new DomainError('not_found');
    }
    const position = (
      await this.persistence.spaces.list(communityId, { limit: 100 })
    ).items.length;
    return this.persistence.spaces.create({
      id: randomUUID(),
      communityId,
      categoryId,
      name: name(value),
      kind: 'text',
      position,
      archivedAt: null,
      version: 1,
    });
  }
  async listSpaces(
    actorId: string,
    communityId: string,
    input: ListPage,
  ): Promise<Page<Space>> {
    await this.community(communityId);
    await this.enforce(actorId, 'space.view', [
      { type: 'community', id: communityId },
    ]);
    return this.persistence.spaces.list(communityId, page(input));
  }
  async updateSpace(
    actorId: string,
    id: string,
    input: {
      name?: string | undefined;
      position?: number | undefined;
      categoryId?: string | null | undefined;
      archived?: boolean | undefined;
      expectedVersion: number;
    },
  ): Promise<Space> {
    const current = await this.persistence.spaces.findById(id);
    if (!current) throw new DomainError('not_found');
    await this.enforce(actorId, 'space.manage', [
      { type: 'community', id: current.communityId },
      { type: 'space', id },
    ]);
    const categoryId =
      input.categoryId === undefined ? current.categoryId : input.categoryId;
    if (categoryId) {
      const category = await this.persistence.categories.findById(categoryId);
      if (
        !category ||
        category.communityId !== current.communityId ||
        category.archivedAt
      )
        throw new DomainError('not_found');
    }
    return this.saved(
      await this.persistence.spaces.update(
        id,
        {
          name: input.name === undefined ? current.name : name(input.name),
          position:
            input.position === undefined
              ? current.position
              : position(input.position),
          categoryId,
          archivedAt: input.archived
            ? new Date().toISOString()
            : current.archivedAt,
        },
        input.expectedVersion,
      ),
    );
  }

  async postMessage(
    spaceId: string,
    authorId: string,
    body: string,
    key: string = randomUUID(),
    replyToId: string | null = null,
  ): Promise<Message> {
    const space = await this.persistence.spaces.findById(spaceId);
    if (
      !space ||
      space.archivedAt ||
      !(await this.persistence.accounts.findById(authorId))
    )
      throw new DomainError('not_found');
    if (space.categoryId) {
      const category = await this.persistence.categories.findById(
        space.categoryId,
      );
      if (!category || category.archivedAt) throw new DomainError('not_found');
    }
    const scopes = [
      { type: 'community', id: space.communityId },
      ...(space.categoryId
        ? [{ type: 'category' as const, id: space.categoryId }]
        : []),
      { type: 'space', id: space.id },
    ] as const;
    await this.enforce(authorId, 'message.create', scopes);
    const normalizedKey = idempotencyKey(key);
    const existing = await this.persistence.messages.findByIdempotencyKey(
      authorId,
      spaceId,
      normalizedKey,
    );
    if (existing) return existing;
    if (replyToId) {
      const reply = await this.persistence.messages.findById(replyToId);
      if (!reply || reply.spaceId !== spaceId)
        throw new DomainError('not_found');
    }
    return this.persistence.transaction(async (persistence) => {
      await this.enforce(authorId, 'message.create', scopes);
      const retried = await persistence.messages.findByIdempotencyKey(
        authorId,
        spaceId,
        normalizedKey,
      );
      if (retried) return retried;
      const now = new Date().toISOString();
      return persistence.messages.create({
        id: randomUUID(),
        spaceId,
        authorId,
        body: messageBody(body),
        replyToId,
        idempotencyKey: normalizedKey,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      });
    });
  }
  async listMessages(
    spaceId: string,
    actorId: string,
    input: ListPage,
  ): Promise<Page<Message>> {
    await this.authorizeSpaceSubscription(spaceId, actorId);
    return this.persistence.messages.list(spaceId, page(input));
  }
  async editMessage(
    id: string,
    actorId: string,
    body: string,
    expectedVersion: number,
  ): Promise<Message> {
    return this.mutateMessage(id, actorId, async (message, persistence) => {
      if (message.deletedAt) throw new DomainError('conflict');
      return this.saved(
        await persistence.messages.update(
          id,
          messageBody(body),
          expectedVersion,
          new Date().toISOString(),
        ),
      );
    });
  }
  async deleteMessage(
    id: string,
    actorId: string,
    expectedVersion: number,
  ): Promise<Message> {
    return this.mutateMessage(id, actorId, async (_message, persistence) =>
      this.saved(
        await persistence.messages.tombstone(
          id,
          expectedVersion,
          new Date().toISOString(),
        ),
      ),
    );
  }
  async createInvitation(
    actorId: string,
    communityId: string,
    input: {
      expiresInSeconds: number;
      maxUses: number;
      targetAccountId?: string | null;
    },
    correlationId: string = randomUUID(),
  ): Promise<{ invitation: Invitation; token: string }> {
    await this.limitInvitation(`create:${actorId}`);
    try {
      const community = await this.community(communityId);
      await this.enforce(actorId, 'invitation.create', [
        { type: 'community', id: community.id },
      ]);
      if (
        !Number.isInteger(input.expiresInSeconds) ||
        input.expiresInSeconds < 60 ||
        input.expiresInSeconds > 2_592_000 ||
        !Number.isInteger(input.maxUses) ||
        input.maxUses < 1 ||
        input.maxUses > 100
      )
        throw new DomainError('conflict');
      const targetAccountId = input.targetAccountId ?? null;
      if (
        targetAccountId &&
        !(await this.persistence.accounts.findById(targetAccountId))
      )
        throw new DomainError('not_found');
      const token = this.issueInvitationToken();
      const createdAt = new Date().toISOString();
      const invitation: Invitation = {
        id: randomUUID(),
        communityId,
        creatorId: actorId,
        tokenHash: protectInvitationToken(token),
        targetAccountId,
        createdAt,
        expiresAt: new Date(
          new Date(createdAt).getTime() + input.expiresInSeconds * 1000,
        ).toISOString(),
        maxUses: input.maxUses,
        useCount: 0,
        revokedAt: null,
        version: 1,
      };
      await this.persistence.transaction(async (persistence) => {
        await persistence.invitations.create(invitation);
        await persistence.auditEvents.create(
          this.audit(
            actorId,
            communityId,
            'invitation',
            invitation.id,
            'invitation.create',
            'succeeded',
            null,
            correlationId,
          ),
        );
      });
      return { invitation, token };
    } catch (error) {
      await this.rejectedAudit(
        actorId,
        communityId,
        'invitation.create',
        error,
        correlationId,
      );
      throw error;
    }
  }
  async listInvitations(
    actorId: string,
    communityId: string,
  ): Promise<Invitation[]> {
    await this.community(communityId);
    await this.enforce(actorId, 'invitation.manage', [
      { type: 'community', id: communityId },
    ]);
    return this.persistence.invitations.list(communityId);
  }
  async listAuditEvents(
    actorId: string,
    communityId: string,
    page: ListPage,
  ): Promise<Page<AuditEvent>> {
    await this.community(communityId);
    await this.enforce(actorId, 'moderation.audit', [
      { type: 'community', id: communityId },
    ]);
    return this.persistence.auditEvents.list(communityId, page);
  }
  async verifyAuditEvents(
    actorId: string,
    communityId: string,
  ): Promise<AuditIntegrity> {
    await this.community(communityId);
    await this.enforce(actorId, 'moderation.audit', [
      { type: 'community', id: communityId },
    ]);
    return this.persistence.auditEvents.verify(communityId);
  }
  async checkpointAuditEvents(
    actorId: string,
    communityId: string,
    correlationId: string = randomUUID(),
  ): Promise<AuditCheckpoint> {
    await this.community(communityId);
    await this.enforce(actorId, 'moderation.audit', [
      { type: 'community', id: communityId },
    ]);
    return this.persistence.transaction(async (persistence) => {
      const now = new Date().toISOString();
      const event = await persistence.auditEvents.create(
        this.audit(
          actorId,
          communityId,
          'audit_chain',
          communityId,
          'audit.checkpoint',
          'succeeded',
          null,
          correlationId,
          now,
        ),
      );
      return persistence.auditEvents.checkpoint({
        id: randomUUID(),
        communityId,
        sequence: event.sequence,
        headHash: event.eventHash,
        actorType: 'account',
        actorId,
        correlationId,
        createdAt: now,
      });
    });
  }
  async setAuditLegalHold(
    actorId: string,
    communityId: string,
    held: boolean,
    reasonCode: string,
    correlationId: string = randomUUID(),
  ): Promise<AuditEvent> {
    await this.community(communityId);
    await this.enforce(actorId, 'moderation.audit', [
      { type: 'community', id: communityId },
    ]);
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(reasonCode))
      throw new DomainError('conflict');
    return this.persistence.auditEvents.create(
      this.audit(
        actorId,
        communityId,
        'community',
        communityId,
        held ? 'audit.legal_hold.apply' : 'audit.legal_hold.release',
        'succeeded',
        reasonCode,
        correlationId,
      ),
    );
  }
  async auditRetention(
    actorId: string,
    communityId: string,
    now = new Date().toISOString(),
  ): Promise<AuditRetention> {
    await this.community(communityId);
    await this.enforce(actorId, 'moderation.audit', [
      { type: 'community', id: communityId },
    ]);
    return this.persistence.auditEvents.retention(communityId, now);
  }
  async revokeInvitation(
    actorId: string,
    invitationId: string,
    expectedVersion: number,
    correlationId: string = randomUUID(),
  ): Promise<Invitation> {
    await this.limitInvitation(`admin:${actorId}`);
    const invitation =
      await this.persistence.invitations.findById(invitationId);
    const communityId = invitation?.communityId ?? null;
    try {
      if (!invitation) throw new DomainError('not_found');
      await this.enforce(actorId, 'invitation.manage', [
        { type: 'community', id: invitation.communityId },
      ]);
      return await this.persistence.transaction(async (persistence) => {
        const revoked = await persistence.invitations.revoke(
          invitation.id,
          expectedVersion,
          new Date().toISOString(),
        );
        if (!revoked) throw new DomainError('stale_write');
        await persistence.auditEvents.create(
          this.audit(
            actorId,
            invitation.communityId,
            'invitation',
            invitation.id,
            'invitation.revoke',
            'succeeded',
            null,
            correlationId,
          ),
        );
        return revoked;
      });
    } catch (error) {
      await this.rejectedAudit(
        actorId,
        communityId,
        'invitation.revoke',
        error,
        correlationId,
      );
      throw error;
    }
  }
  async previewInvitation(
    actorId: string,
    token: string,
  ): Promise<{
    communityId: string;
    communityName: string;
    expiresAt: string;
  }> {
    await this.limitInvitation(`preview:${actorId}`);
    const invitation = await this.validInvitation(actorId, token);
    const community = await this.community(invitation.communityId);
    return {
      communityId: community.id,
      communityName: community.name,
      expiresAt: invitation.expiresAt,
    };
  }
  async acceptInvitation(
    actorId: string,
    token: string,
    source = actorId,
    correlationId: string = randomUUID(),
  ): Promise<Membership> {
    await this.limitInvitation(`accept:${source}`);
    let communityId: string | null = null;
    try {
      const tokenHash = protectInvitationToken(token);
      return await this.persistence.transaction(async (persistence) => {
        const invitation =
          await persistence.invitations.findByTokenHash(tokenHash);
        if (
          !invitation ||
          (invitation.targetAccountId && invitation.targetAccountId !== actorId)
        )
          throw new DomainError('invitation_unavailable');
        communityId = invitation.communityId;
        const existing =
          await persistence.memberships.findByCommunityAndAccount(
            invitation.communityId,
            actorId,
          );
        if (existing?.status === 'active') return existing;
        if (existing && ['removed', 'suspended'].includes(existing.status))
          throw new DomainError('invitation_unavailable');
        this.ensureInvitationUsable(invitation, new Date());
        const community = await persistence.communities.findById(
          invitation.communityId,
        );
        if (!community || community.archivedAt)
          throw new DomainError('invitation_unavailable');
        if (!(await persistence.accounts.findById(actorId)))
          throw new DomainError('invitation_unavailable');
        const now = new Date().toISOString();
        const claimed = await persistence.invitations.claim(
          invitation.id,
          invitation.version,
          now,
        );
        if (!claimed) throw new DomainError('invitation_unavailable');
        const membership = existing
          ? await persistence.memberships.updateStatus(
              existing.id,
              'active',
              existing.version,
              now,
            )
          : await persistence.memberships.create({
              id: randomUUID(),
              communityId: invitation.communityId,
              accountId: actorId,
              status: 'active',
              createdAt: now,
              updatedAt: now,
              version: 1,
            });
        if (!membership) throw new DomainError('invitation_unavailable');
        await persistence.auditEvents.create(
          this.audit(
            actorId,
            invitation.communityId,
            'invitation',
            invitation.id,
            'invitation.accept',
            'succeeded',
            null,
            correlationId,
          ),
        );
        return membership;
      });
    } catch (error) {
      await this.rejectedAudit(
        actorId,
        communityId,
        'invitation.accept',
        error,
        correlationId,
      );
      throw error;
    }
  }
  private async validInvitation(
    actorId: string,
    token: string,
  ): Promise<Invitation> {
    let invitation: Invitation | undefined;
    try {
      invitation = await this.persistence.invitations.findByTokenHash(
        protectInvitationToken(token),
      );
    } catch {
      throw new DomainError('invitation_unavailable');
    }
    if (
      !invitation ||
      (invitation.targetAccountId && invitation.targetAccountId !== actorId)
    )
      throw new DomainError('invitation_unavailable');
    this.ensureInvitationUsable(invitation, new Date());
    return invitation;
  }
  private ensureInvitationUsable(invitation: Invitation, now: Date): void {
    if (
      invitation.revokedAt ||
      now >= new Date(invitation.expiresAt) ||
      invitation.useCount >= invitation.maxUses
    )
      throw new DomainError('invitation_unavailable');
  }
  private async limitInvitation(key: string): Promise<void> {
    if (!(await this.invitationLimiter.consume(key, new Date())))
      throw new DomainError('rate_limited');
  }
  private audit(
    actorId: string,
    communityId: string | null,
    targetType: AuditEvent['targetType'],
    targetId: string | null,
    action: AuditEvent['action'],
    outcome: AuditEvent['outcome'] = 'succeeded',
    reasonCode: string | null = null,
    correlationId: string = randomUUID(),
    occurredAt = new Date().toISOString(),
  ): AuditEventInput {
    const retention = new Date(occurredAt);
    retention.setUTCFullYear(retention.getUTCFullYear() + 7);
    return {
      version: 1,
      id: randomUUID(),
      actorType: 'account',
      actorId,
      scopeType: communityId ? 'community' : 'instance',
      scopeId: communityId,
      targetType,
      targetId,
      action,
      outcome,
      reasonCode,
      correlationId,
      occurredAt,
      retentionUntil: retention.toISOString(),
    };
  }
  private async rejectedAudit(
    actorId: string,
    communityId: string | null,
    action: 'invitation.accept' | 'invitation.create' | 'invitation.revoke',
    error: unknown,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.persistence.auditEvents.create(
        this.audit(
          actorId,
          communityId,
          'none',
          null,
          action,
          'rejected',
          error instanceof DomainError ? error.code : 'operation_failed',
          correlationId,
        ),
      );
    } catch {
      // Audit storage failures must not expose or replace the original denial.
    }
  }
  private async mutateMessage(
    id: string,
    actorId: string,
    mutation: (message: Message, persistence: Persistence) => Promise<Message>,
  ): Promise<Message> {
    return this.persistence.transaction(async (persistence) => {
      const message = await persistence.messages.findById(id);
      if (!message) throw new DomainError('not_found');
      const space = await persistence.spaces.findById(message.spaceId);
      if (!space || space.archivedAt) throw new DomainError('not_found');
      const scopes = [
        { type: 'community' as const, id: space.communityId },
        { type: 'space' as const, id: space.id },
      ];
      if (message.authorId === actorId)
        await this.enforce(actorId, 'message.create', scopes);
      else await this.enforce(actorId, 'message.manage', scopes);
      return mutation(message, persistence);
    });
  }
  async authorizeSpaceSubscription(
    spaceId: string,
    actorId: string,
  ): Promise<void> {
    const space = await this.persistence.spaces.findById(spaceId);
    if (
      !space ||
      space.archivedAt ||
      !(await this.persistence.accounts.findById(actorId))
    )
      throw new DomainError('not_found');
    if (space.categoryId) {
      const category = await this.persistence.categories.findById(
        space.categoryId,
      );
      if (!category || category.archivedAt) throw new DomainError('not_found');
    }
    await this.enforce(actorId, 'space.view', [
      { type: 'community', id: space.communityId },
      ...(space.categoryId
        ? [{ type: 'category' as const, id: space.categoryId }]
        : []),
      { type: 'space', id: space.id },
    ]);
  }
  private async community(id: string): Promise<Community> {
    const value = await this.persistence.communities.findById(id);
    if (!value || value.archivedAt) throw new DomainError('not_found');
    return value;
  }
  private async enforce(
    actorId: string,
    permission: Parameters<AuthorizationGateway['enforce']>[1],
    scopes: Parameters<AuthorizationGateway['enforce']>[2],
  ): Promise<void> {
    if (this.authorization) {
      await this.authorization.enforce(actorId, permission, scopes);
      return;
    }
    const communityId = scopes.find((scope) => scope.type === 'community')?.id;
    const community = communityId
      ? await this.persistence.communities.findById(communityId)
      : undefined;
    const membership = communityId
      ? await this.persistence.memberships.findByCommunityAndAccount(
          communityId,
          actorId,
        )
      : undefined;
    if (
      !community ||
      (community.ownerId !== actorId && membership?.status !== 'active')
    )
      throw new DomainError('forbidden');
  }
  private saved<T>(value: T | undefined): T {
    if (!value) throw new DomainError('stale_write');
    return value;
  }
}

type MemoryState = {
  accounts: Map<string, Account>;
  communities: Map<string, Community>;
  memberships: Map<string, Membership>;
  categories: Map<string, Category>;
  spaces: Map<string, Space>;
  messages: Map<string, Message>;
  sessions: Map<string, SessionRecord>;
  invitations: Map<string, Invitation>;
  auditEvents: Map<string, AuditEvent>;
  auditCheckpoints: Map<string, AuditCheckpoint>;
};
const clone = (state: MemoryState): MemoryState => ({
  accounts: new Map(state.accounts),
  communities: new Map(state.communities),
  memberships: new Map(state.memberships),
  categories: new Map(state.categories),
  spaces: new Map(state.spaces),
  messages: new Map(state.messages),
  sessions: new Map(state.sessions),
  invitations: new Map(state.invitations),
  auditEvents: new Map(state.auditEvents),
  auditCheckpoints: new Map(state.auditCheckpoints),
});
const cursor = (id: string): string => Buffer.from(id).toString('base64url');
const after = (value?: string): string =>
  value ? Buffer.from(value, 'base64url').toString() : '';
const positionCursor = (position: number, id: string): string =>
  Buffer.from(`${String(position)}:${id}`).toString('base64url');
const afterPosition = (value?: string): [number, string] => {
  if (!value) return [-1, ''];
  const [position, id = ''] = Buffer.from(value, 'base64url')
    .toString()
    .split(':');
  return [Number(position), id];
};

export class InMemoryPersistence implements Persistence {
  private state: MemoryState = {
    accounts: new Map(),
    communities: new Map(),
    memberships: new Map(),
    categories: new Map(),
    spaces: new Map(),
    messages: new Map(),
    sessions: new Map(),
    invitations: new Map(),
    auditEvents: new Map(),
    auditCheckpoints: new Map(),
  };
  /* eslint-disable @typescript-eslint/require-await -- async parity with storage ports */
  readonly accounts = {
    create: async (v: Account) => (this.state.accounts.set(v.id, v), v),
    findById: async (id: string) => this.state.accounts.get(id),
  };
  readonly communities = {
    create: async (v: Community) => {
      if (
        [...this.state.communities.values()].some(
          (c) =>
            c.ownerId === v.ownerId &&
            !c.archivedAt &&
            c.name.toLocaleLowerCase() === v.name.toLocaleLowerCase(),
        )
      )
        throw new DomainError('conflict');
      this.state.communities.set(v.id, v);
      return v;
    },
    findById: async (id: string) => this.state.communities.get(id),
    listVisible: async (accountId: string, p: ListPage) => {
      const membershipIds = new Set(
        [...this.state.memberships.values()]
          .filter((m) => m.accountId === accountId && m.status === 'active')
          .map((m) => m.communityId),
      );
      const values = [...this.state.communities.values()]
        .filter((c) => !c.archivedAt && membershipIds.has(c.id))
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((v) => v.id > after(p.cursor));
      const items = values.slice(0, p.limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor: values.length > p.limit && last ? cursor(last.id) : null,
      };
    },
    update: async (id: string, value: string, version: number) =>
      this.updateMap(this.state.communities, id, version, (v) => ({
        ...v,
        name: value,
      })),
    archive: async (id: string, version: number, archivedAt: string) =>
      this.updateMap(this.state.communities, id, version, (v) => ({
        ...v,
        archivedAt,
      })),
  };
  readonly memberships = {
    create: async (v: Membership) => {
      if (
        [...this.state.memberships.values()].some(
          (m) => m.communityId === v.communityId && m.accountId === v.accountId,
        )
      )
        throw new DomainError('conflict');
      this.state.memberships.set(v.id, v);
      return v;
    },
    findByCommunityAndAccount: async (communityId: string, accountId: string) =>
      [...this.state.memberships.values()].find(
        (m) => m.communityId === communityId && m.accountId === accountId,
      ),
    list: async (communityId: string) =>
      [...this.state.memberships.values()]
        .filter((m) => m.communityId === communityId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    updateStatus: async (
      id: string,
      status: MembershipStatus,
      version: number,
      updatedAt: string,
    ) =>
      this.updateMap(this.state.memberships, id, version, (v) => ({
        ...v,
        status,
        updatedAt,
      })),
  };
  readonly categories = {
    create: async (v: Category) => {
      this.uniqueCategory(v);
      this.state.categories.set(v.id, v);
      return v;
    },
    findById: async (id: string) => this.state.categories.get(id),
    list: async (communityId: string, includeArchived = false) =>
      [...this.state.categories.values()]
        .filter(
          (v) =>
            v.communityId === communityId && (includeArchived || !v.archivedAt),
        )
        .sort(order),
    update: async (
      id: string,
      input: Pick<Category, 'name' | 'position' | 'archivedAt'>,
      version: number,
    ) => {
      const current = this.state.categories.get(id);
      if (!current || current.version !== version) return undefined;
      const next = { ...current, ...input, version: version + 1 };
      this.uniqueCategory(next, id);
      this.state.categories.set(id, next);
      return next;
    },
    remove: async (id: string) => this.state.categories.delete(id),
    rename: async (id: string, value: string) => {
      const current = this.state.categories.get(id);
      return current
        ? this.categories.update(
            id,
            { ...current, name: value },
            current.version,
          )
        : undefined;
    },
  };
  readonly spaces = {
    create: async (v: Space) => {
      this.uniqueSpace(v);
      this.state.spaces.set(v.id, v);
      return v;
    },
    findById: async (id: string) => this.state.spaces.get(id),
    list: async (communityId: string, p: ListPage, includeArchived = false) => {
      const [afterOrder, afterId] = afterPosition(p.cursor);
      const values = [...this.state.spaces.values()]
        .filter(
          (v) =>
            v.communityId === communityId &&
            (includeArchived || !v.archivedAt) &&
            (v.categoryId === null ||
              includeArchived ||
              !this.state.categories.get(v.categoryId)?.archivedAt),
        )
        .sort(order)
        .filter(
          (v) =>
            v.position > afterOrder ||
            (v.position === afterOrder && v.id > afterId),
        );
      const items = values.slice(0, p.limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          values.length > p.limit && last
            ? positionCursor(last.position, last.id)
            : null,
      };
    },
    update: async (
      id: string,
      input: Pick<Space, 'name' | 'position' | 'categoryId' | 'archivedAt'>,
      version: number,
    ) => {
      const current = this.state.spaces.get(id);
      if (!current || current.version !== version) return undefined;
      const next = { ...current, ...input, version: version + 1 };
      this.uniqueSpace(next, id);
      this.state.spaces.set(id, next);
      return next;
    },
    remove: async (id: string) => this.state.spaces.delete(id),
    rename: async (id: string, value: string) => {
      const current = this.state.spaces.get(id);
      return current
        ? this.spaces.update(id, { ...current, name: value }, current.version)
        : undefined;
    },
  };
  readonly messages = {
    create: async (v: Message) => {
      const existing = await this.messages.findByIdempotencyKey(
        v.authorId,
        v.spaceId,
        v.idempotencyKey,
      );
      if (existing) return existing;
      this.state.messages.set(v.id, v);
      return v;
    },
    findById: async (id: string) => this.state.messages.get(id),
    findByIdempotencyKey: async (
      authorId: string,
      spaceId: string,
      key: string,
    ) =>
      [...this.state.messages.values()].find(
        (v) =>
          v.authorId === authorId &&
          v.spaceId === spaceId &&
          v.idempotencyKey === key,
      ),
    list: async (spaceId: string, p: ListPage) => {
      const values = [...this.state.messages.values()]
        .filter((v) => v.spaceId === spaceId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        )
        .filter((v) => `${v.createdAt}:${v.id}` > after(p.cursor));
      const items = values.slice(0, p.limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          values.length > p.limit && last
            ? cursor(`${last.createdAt}:${last.id}`)
            : null,
      };
    },
    update: async (
      id: string,
      body: string,
      version: number,
      updatedAt: string,
    ) =>
      this.updateMap(this.state.messages, id, version, (v) => ({
        ...v,
        body,
        updatedAt,
      })),
    tombstone: async (id: string, version: number, deletedAt: string) =>
      this.updateMap(this.state.messages, id, version, (v) => ({
        ...v,
        body: null,
        deletedAt: v.deletedAt ?? deletedAt,
        updatedAt: deletedAt,
      })),
    remove: async (id: string) => this.state.messages.delete(id),
  };
  readonly sessions = {
    create: async (v: SessionRecord) => (this.state.sessions.set(v.id, v), v),
    findByTokenHash: async (value: string) =>
      [...this.state.sessions.values()].find((v) => v.tokenHash === value),
    revoke: async (id: string, revokedAt: string) => {
      const v = this.state.sessions.get(id);
      if (!v) return false;
      this.state.sessions.set(id, { ...v, revokedAt });
      return true;
    },
  };
  readonly invitations = {
    create: async (v: Invitation) => {
      if (
        [...this.state.invitations.values()].some(
          (invitation) => invitation.tokenHash === v.tokenHash,
        )
      )
        throw new DomainError('conflict');
      this.state.invitations.set(v.id, v);
      return v;
    },
    findById: async (id: string) => this.state.invitations.get(id),
    findByTokenHash: async (value: string) =>
      [...this.state.invitations.values()].find(
        (invitation) => invitation.tokenHash === value,
      ),
    list: async (communityId: string) =>
      [...this.state.invitations.values()]
        .filter((invitation) => invitation.communityId === communityId)
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
        ),
    claim: async (id: string, version: number, acceptedAt: string) => {
      const current = this.state.invitations.get(id);
      if (
        !current ||
        current.version !== version ||
        current.revokedAt ||
        new Date(acceptedAt) >= new Date(current.expiresAt) ||
        current.useCount >= current.maxUses
      )
        return undefined;
      const next = {
        ...current,
        useCount: current.useCount + 1,
        version: version + 1,
      };
      this.state.invitations.set(id, next);
      return next;
    },
    revoke: async (id: string, version: number, revokedAt: string) => {
      const current = this.state.invitations.get(id);
      if (!current || current.version !== version) return undefined;
      const next = {
        ...current,
        revokedAt: current.revokedAt ?? revokedAt,
        version: version + 1,
      };
      this.state.invitations.set(id, next);
      return next;
    },
  };
  readonly auditEvents = {
    create: async (v: AuditEventInput) => {
      if (this.state.auditEvents.has(v.id)) throw new DomainError('conflict');
      const events = [...this.state.auditEvents.values()]
        .filter(
          (event) =>
            event.scopeType === v.scopeType && event.scopeId === v.scopeId,
        )
        .sort((a, b) => a.sequence - b.sequence);
      const previousHash = events.at(-1)?.eventHash ?? zeroAuditHash;
      const event: AuditEvent = {
        ...v,
        sequence: events.length + 1,
        previousHash,
        eventHash: auditEventHash(previousHash, v),
      };
      this.state.auditEvents.set(event.id, event);
      return event;
    },
    list: async (communityId: string, page: ListPage) => {
      const values = [...this.state.auditEvents.values()]
        .filter(
          (event) =>
            event.scopeType === 'community' && event.scopeId === communityId,
        )
        .sort((a, b) => a.sequence - b.sequence);
      const offset = page.cursor ? Number(after(page.cursor)) : 0;
      const items = values.slice(offset, offset + page.limit);
      const next = offset + items.length;
      return {
        items,
        nextCursor: next < values.length ? cursor(String(next)) : null,
      };
    },
    verify: async (communityId: string) => {
      const events = [...this.state.auditEvents.values()]
        .filter(
          (event) =>
            event.scopeType === 'community' && event.scopeId === communityId,
        )
        .sort((a, b) => a.sequence - b.sequence);
      const checkpoint = [...this.state.auditCheckpoints.values()]
        .filter((value) => value.communityId === communityId)
        .sort((a, b) => b.sequence - a.sequence)[0];
      let previousHash = zeroAuditHash;
      let valid = true;
      for (const [index, event] of events.entries()) {
        valid &&=
          event.sequence === index + 1 &&
          event.previousHash === previousHash &&
          event.eventHash === auditEventHash(previousHash, event);
        previousHash = event.eventHash;
      }
      return {
        valid,
        count: events.length,
        headHash: events.at(-1)?.eventHash ?? null,
        checkpointSequence: checkpoint?.sequence ?? null,
        checkpointHash: checkpoint?.headHash ?? null,
        checkpointValid: checkpoint
          ? events[checkpoint.sequence - 1]?.eventHash === checkpoint.headHash
          : true,
      };
    },
    checkpoint: async (checkpoint: AuditCheckpoint) => {
      const head = [...this.state.auditEvents.values()]
        .filter(
          (event) =>
            event.scopeType === 'community' &&
            event.scopeId === checkpoint.communityId,
        )
        .sort((a, b) => b.sequence - a.sequence)[0];
      if (
        !head ||
        head.sequence !== checkpoint.sequence ||
        head.eventHash !== checkpoint.headHash ||
        [...this.state.auditCheckpoints.values()].some(
          (value) =>
            value.communityId === checkpoint.communityId &&
            value.sequence === checkpoint.sequence,
        )
      )
        throw new DomainError('conflict');
      this.state.auditCheckpoints.set(checkpoint.id, checkpoint);
      return checkpoint;
    },
    retention: async (communityId: string, now: string) => {
      const events = [...this.state.auditEvents.values()]
        .filter(
          (event) =>
            event.scopeType === 'community' && event.scopeId === communityId,
        )
        .sort((a, b) => a.sequence - b.sequence);
      const directive = events
        .filter((event) => event.action.startsWith('audit.legal_hold.'))
        .at(-1);
      const legalHold = directive?.action === 'audit.legal_hold.apply';
      return {
        policy: 'security_7y' as const,
        legalHold,
        eligibleThroughSequence: legalHold
          ? 0
          : (events.filter((event) => event.retentionUntil <= now).at(-1)
              ?.sequence ?? 0),
      };
    },
  };
  /* eslint-enable @typescript-eslint/require-await */
  private transactionQueue: Promise<void> = Promise.resolve();
  async transaction<T>(work: (p: Persistence) => Promise<T>): Promise<T> {
    const previous = this.transactionQueue;
    let release = () => {};
    this.transactionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const before = clone(this.state);
    try {
      return await work(this);
    } catch (error) {
      this.state = before;
      throw error;
    } finally {
      release();
    }
  }
  private updateMap<T extends { version: number }>(
    map: Map<string, T>,
    id: string,
    version: number,
    change: (value: T) => T,
  ): T | undefined {
    const current = map.get(id);
    if (!current || current.version !== version) return undefined;
    const next = { ...change(current), version: version + 1 };
    map.set(id, next);
    return next;
  }
  private uniqueCategory(value: Category, except?: string) {
    if (
      !value.archivedAt &&
      [...this.state.categories.values()].some(
        (v) =>
          v.id !== except &&
          v.communityId === value.communityId &&
          !v.archivedAt &&
          v.name.toLocaleLowerCase() === value.name.toLocaleLowerCase(),
      )
    )
      throw new DomainError('conflict');
  }
  private uniqueSpace(value: Space, except?: string) {
    if (
      !value.archivedAt &&
      [...this.state.spaces.values()].some(
        (v) =>
          v.id !== except &&
          v.communityId === value.communityId &&
          !v.archivedAt &&
          v.name.toLocaleLowerCase() === value.name.toLocaleLowerCase(),
      )
    )
      throw new DomainError('conflict');
  }
}
const order = <T extends { position: number; id: string }>(a: T, b: T) =>
  a.position - b.position || a.id.localeCompare(b.id);
export class InMemoryCommunityService extends CommunityService {
  constructor(
    persistence = new InMemoryPersistence(),
    authorization?: AuthorizationGateway,
    invitationLimiter?: InvitationRateLimiter,
    issueInvitationToken?: () => string,
  ) {
    super(persistence, authorization, invitationLimiter, issueInvitationToken);
  }
}
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
