import { createHash, randomBytes, randomUUID } from 'node:crypto';
export * from './unread.js';
export * from './spam.js';
export * from './retention.js';
export * from './privacy-export.js';
export * from './account-deletion.js';
export * from './direct.js';

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
  slowModeSeconds: number;
  version: number;
}
export interface Message {
  id: string;
  spaceId: string;
  authorId: string;
  body: string | null;
  replyToId: string | null;
  idempotencyKey: string;
  requestFingerprint: string;
  createdEventId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
}
export interface MessageReaction {
  messageId: string;
  actorId: string;
  key: string;
  createdAt: string;
}
export interface ReactionAggregate {
  key: string;
  count: number;
  reactedByActor: boolean;
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
  id: string;
  actorId: string;
  communityId: string | null;
  invitationId: string | null;
  action: 'invitation.create' | 'invitation.revoke' | 'invitation.accept';
  outcome: 'succeeded' | 'rejected';
  occurredAt: string;
}
export interface ModerationRestriction {
  id: string;
  communityId: string;
  actorId: string;
  targetAccountId: string;
  kind: 'timeout' | 'ban';
  reason: string;
  requestFingerprint: string;
  idempotencyKey: string;
  correlationId: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  version: number;
}
export interface ModerationAuditEvent {
  id: string;
  communityId: string;
  actorId: string;
  targetAccountId: string | null;
  targetMessageId: string | null;
  action: string;
  outcome: 'succeeded' | 'rejected';
  reason: string | null;
  correlationId: string;
  occurredAt: string;
  previousHash: string | null;
  eventHash: string;
  metadata: Record<string, string | number | boolean | null>;
}
export interface ModerationMessageEvidence {
  id: string;
  communityId: string;
  messageId: string;
  bodySnapshot: string;
  contentHash: string;
  capturedAt: string;
  retainedUntil: string;
  legalHold: boolean;
}
export interface ModerationMessageDeletion {
  id: string;
  communityId: string;
  messageId: string;
  actorId: string;
  targetAccountId: string;
  evidenceId: string;
  reason: string;
  requestFingerprint: string;
  idempotencyKey: string;
  correlationId: string;
  eventId: string;
  createdAt: string;
}
export type SafetyReportCategory =
  'spam' | 'harassment' | 'threat' | 'self_harm' | 'other';
export interface SafetyReport {
  id: string;
  communityId: string;
  reporterId: string;
  targetAccountId: string | null;
  targetMessageId: string | null;
  category: SafetyReportCategory;
  description: string;
  evidenceReferenceIds: string[];
  status: 'submitted' | 'triaged' | 'actioned' | 'dismissed';
  requestFingerprint: string;
  idempotencyKey: string;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface ModerationCase {
  id: string;
  communityId: string;
  reportId: string;
  assigneeId: string | null;
  status: 'open' | 'investigating' | 'resolved' | 'closed';
  idempotencyKey: string;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  version: number;
}
export interface ModerationCaseActivity {
  id: string;
  caseId: string;
  actorId: string;
  kind: 'opened' | 'assigned' | 'status_changed' | 'note' | 'action_linked';
  note: string | null;
  linkedActionId: string | null;
  occurredAt: string;
}
export interface ModerationAppeal {
  id: string;
  communityId: string;
  appellantId: string;
  restrictionId: string;
  statement: string;
  status: 'submitted' | 'upheld' | 'overturned';
  reviewerId: string | null;
  decisionReason: string | null;
  idempotencyKey: string;
  correlationId: string;
  createdAt: string;
  decidedAt: string | null;
  version: number;
}
export interface CommunityContentLimits {
  communityId: string;
  messageBodyMax: number;
  reportDescriptionMax: number;
  moderationReasonMax: number;
  updatedBy: string;
  updatedAt: string;
  version: number;
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
      input: Pick<
        Space,
        'name' | 'position' | 'categoryId' | 'archivedAt' | 'slowModeSeconds'
      >,
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
  reactions: {
    add(reaction: MessageReaction): Promise<boolean>;
    remove(messageId: string, actorId: string, key: string): Promise<boolean>;
    list(messageId: string, actorId: string): Promise<ReactionAggregate[]>;
  };
  messagePacing: {
    consume(
      spaceId: string,
      actorId: string,
      intervalSeconds: number,
      now: string,
    ): Promise<number>;
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
    create(event: AuditEvent): Promise<AuditEvent>;
    list(communityId: string): Promise<AuditEvent[]>;
  };
  moderationRestrictions: {
    create(value: ModerationRestriction): Promise<ModerationRestriction>;
    findById(id: string): Promise<ModerationRestriction | undefined>;
    findByIdempotencyKey(
      actorId: string,
      communityId: string,
      key: string,
    ): Promise<ModerationRestriction | undefined>;
    findEffective(
      communityId: string,
      accountId: string,
      now: string,
    ): Promise<ModerationRestriction | undefined>;
    revoke(
      id: string,
      expectedVersion: number,
      revokedAt: string,
    ): Promise<ModerationRestriction | undefined>;
  };
  moderationAuditEvents: {
    create(value: ModerationAuditEvent): Promise<ModerationAuditEvent>;
    latestHash(communityId: string): Promise<string | undefined>;
  };
  moderationMessageEvidence: {
    create(
      value: ModerationMessageEvidence,
    ): Promise<ModerationMessageEvidence>;
  };
  moderationMessageDeletions: {
    create(
      value: ModerationMessageDeletion,
    ): Promise<ModerationMessageDeletion>;
    findByIdempotencyKey(
      actorId: string,
      messageId: string,
      key: string,
    ): Promise<ModerationMessageDeletion | undefined>;
  };
  safetyReports: {
    create(value: SafetyReport): Promise<SafetyReport>;
    findById(id: string): Promise<SafetyReport | undefined>;
    findByIdempotencyKey(
      reporterId: string,
      communityId: string,
      key: string,
    ): Promise<SafetyReport | undefined>;
  };
  moderationCases: {
    create(value: ModerationCase): Promise<ModerationCase>;
    findById(id: string): Promise<ModerationCase | undefined>;
    findByIdempotencyKey(
      communityId: string,
      key: string,
    ): Promise<ModerationCase | undefined>;
    list(communityId: string, page: ListPage): Promise<Page<ModerationCase>>;
    update(
      id: string,
      input: Pick<
        ModerationCase,
        'assigneeId' | 'status' | 'closedAt' | 'updatedAt'
      >,
      expectedVersion: number,
    ): Promise<ModerationCase | undefined>;
  };
  moderationCaseActivity: {
    create(value: ModerationCaseActivity): Promise<ModerationCaseActivity>;
    list(caseId: string): Promise<ModerationCaseActivity[]>;
  };
  moderationAppeals: {
    create(value: ModerationAppeal): Promise<ModerationAppeal>;
    findById(id: string): Promise<ModerationAppeal | undefined>;
    findByRestrictionId(
      restrictionId: string,
    ): Promise<ModerationAppeal | undefined>;
    findByIdempotencyKey(
      appellantId: string,
      key: string,
    ): Promise<ModerationAppeal | undefined>;
    decide(
      id: string,
      status: 'upheld' | 'overturned',
      reviewerId: string,
      reason: string,
      decidedAt: string,
      expectedVersion: number,
    ): Promise<ModerationAppeal | undefined>;
  };
  contentLimits: {
    find(communityId: string): Promise<CommunityContentLimits | undefined>;
    put(
      value: CommunityContentLimits,
      expectedVersion?: number,
    ): Promise<CommunityContentLimits | undefined>;
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
    public readonly retryAfterSeconds?: number,
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
      | 'moderation.timeout'
      | 'moderation.ban'
      | 'moderation.message.delete'
      | 'moderation.case'
      | 'moderation.appeal'
      | 'moderation.audit',
    scopes: readonly { type: 'community' | 'category' | 'space'; id: string }[],
  ): Promise<unknown>;
  assertCanModerate?(
    actorId: string,
    targetId: string,
    communityId: string,
    permission:
      'moderation.timeout' | 'moderation.ban' | 'moderation.message.delete',
  ): Promise<void>;
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
function slowMode(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 21_600)
    throw new DomainError('conflict');
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
function reactionKey(value: string): string {
  const normalized = value.normalize('NFC');
  const segments = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      normalized,
    ),
  ];
  if (
    segments.length !== 1 ||
    normalized.length > 16 ||
    !/\p{Extended_Pictographic}/u.test(normalized) ||
    /[\p{L}\p{N}]/u.test(normalized)
  )
    throw new DomainError('conflict');
  return normalized;
}
function moderationReason(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ').normalize('NFC');
  if (!normalized || normalized.length > 500) throw new DomainError('conflict');
  return normalized;
}
function reportDescription(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ').normalize('NFC');
  if (!normalized || normalized.length > 1000)
    throw new DomainError('conflict');
  return normalized;
}
function caseNote(value: string): string {
  const normalized = value.trim().replace(/\r\n?/g, '\n').normalize('NFC');
  if (!normalized || normalized.length > 2000)
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
    private readonly reportLimiter: InvitationRateLimiter = new FixedWindowInvitationRateLimiter(
      10,
      3_600_000,
    ),
    private readonly appealReviewerSeparation = true,
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

  async getContentLimits(
    actorId: string,
    communityId: string,
  ): Promise<CommunityContentLimits> {
    await this.enforce(actorId, 'community.view', [
      { type: 'community', id: communityId },
    ]);
    return (
      (await this.persistence.contentLimits.find(communityId)) ?? {
        communityId,
        messageBodyMax: 4000,
        reportDescriptionMax: 1000,
        moderationReasonMax: 500,
        updatedBy: actorId,
        updatedAt: new Date(0).toISOString(),
        version: 1,
      }
    );
  }

  async updateContentLimits(
    actorId: string,
    communityId: string,
    input: {
      messageBodyMax: number;
      reportDescriptionMax: number;
      moderationReasonMax: number;
      expectedVersion?: number;
      correlationId: string;
    },
  ): Promise<CommunityContentLimits> {
    if (
      !Number.isInteger(input.messageBodyMax) ||
      input.messageBodyMax < 1 ||
      input.messageBodyMax > 4000 ||
      !Number.isInteger(input.reportDescriptionMax) ||
      input.reportDescriptionMax < 1 ||
      input.reportDescriptionMax > 1000 ||
      !Number.isInteger(input.moderationReasonMax) ||
      input.moderationReasonMax < 1 ||
      input.moderationReasonMax > 500
    )
      throw new DomainError('conflict');
    return this.persistence.transaction(async (persistence) => {
      await this.enforce(actorId, 'community.manage', [
        { type: 'community', id: communityId },
      ]);
      const current = await persistence.contentLimits.find(communityId);
      if (current && input.expectedVersion === undefined)
        throw new DomainError('stale_write');
      const updatedAt = new Date().toISOString();
      const saved = await persistence.contentLimits.put(
        {
          communityId,
          messageBodyMax: input.messageBodyMax,
          reportDescriptionMax: input.reportDescriptionMax,
          moderationReasonMax: input.moderationReasonMax,
          updatedBy: actorId,
          updatedAt,
          version: current ? current.version + 1 : 1,
        },
        input.expectedVersion,
      );
      if (!saved) throw new DomainError('stale_write');
      await this.writeModerationAudit(persistence, {
        communityId,
        actorId,
        targetAccountId: null,
        action: 'content_limits.update',
        outcome: 'succeeded',
        reason: null,
        correlationId: input.correlationId,
        metadata: {
          messageBodyMax: saved.messageBodyMax,
          reportDescriptionMax: saved.reportDescriptionMax,
          moderationReasonMax: saved.moderationReasonMax,
        },
      });
      return saved;
    });
  }

  async timeoutMember(
    actorId: string,
    communityId: string,
    targetAccountId: string,
    durationSeconds: number,
    reasonValue: string,
    keyValue: string,
    correlationId: string,
  ): Promise<ModerationRestriction> {
    const reason = moderationReason(reasonValue);
    const key = idempotencyKey(keyValue);
    if (
      !Number.isInteger(durationSeconds) ||
      durationSeconds < 60 ||
      durationSeconds > 2_592_000
    )
      throw new DomainError('conflict');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ targetAccountId, durationSeconds, reason }))
      .digest('hex');
    try {
      await this.assertModerationHierarchy(
        actorId,
        targetAccountId,
        communityId,
        'moderation.timeout',
      );
      return await this.persistence.transaction(async (persistence) => {
        const existing =
          await persistence.moderationRestrictions.findByIdempotencyKey(
            actorId,
            communityId,
            key,
          );
        if (existing) {
          if (existing.requestFingerprint !== fingerprint)
            throw new DomainError('conflict');
          return existing;
        }
        const community = await persistence.communities.findById(communityId);
        const target = await persistence.memberships.findByCommunityAndAccount(
          communityId,
          targetAccountId,
        );
        if (
          !community ||
          community.archivedAt ||
          community.ownerId === targetAccountId ||
          !target ||
          target.status !== 'active'
        )
          throw new DomainError('not_found');
        await this.assertModerationHierarchy(
          actorId,
          targetAccountId,
          communityId,
          'moderation.timeout',
        );
        const createdAt = new Date().toISOString();
        const restriction = await persistence.moderationRestrictions.create({
          id: randomUUID(),
          communityId,
          actorId,
          targetAccountId,
          kind: 'timeout',
          reason,
          requestFingerprint: fingerprint,
          idempotencyKey: key,
          correlationId,
          createdAt,
          expiresAt: new Date(
            new Date(createdAt).getTime() + durationSeconds * 1000,
          ).toISOString(),
          revokedAt: null,
          version: 1,
        });
        await this.writeModerationAudit(persistence, {
          communityId,
          actorId,
          targetAccountId,
          action: 'member.timeout',
          outcome: 'succeeded',
          reason,
          correlationId,
          metadata: { durationSeconds, restrictionId: restriction.id },
        });
        return restriction;
      });
    } catch (error) {
      await this.writeRejectedModerationAudit({
        communityId,
        actorId,
        targetAccountId,
        action: 'member.timeout',
        reason,
        correlationId,
      });
      throw error;
    }
  }

  async banMember(
    actorId: string,
    communityId: string,
    targetAccountId: string,
    durationSeconds: number | null,
    reasonValue: string,
    keyValue: string,
    correlationId: string,
  ): Promise<ModerationRestriction> {
    const reason = moderationReason(reasonValue);
    const key = idempotencyKey(keyValue);
    if (
      durationSeconds !== null &&
      (!Number.isInteger(durationSeconds) ||
        durationSeconds < 60 ||
        durationSeconds > 31_536_000)
    )
      throw new DomainError('conflict');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ targetAccountId, durationSeconds, reason }))
      .digest('hex');
    try {
      await this.assertModerationHierarchy(
        actorId,
        targetAccountId,
        communityId,
        'moderation.ban',
      );
      return await this.persistence.transaction(async (persistence) => {
        const existing =
          await persistence.moderationRestrictions.findByIdempotencyKey(
            actorId,
            communityId,
            key,
          );
        if (existing) {
          if (
            existing.kind !== 'ban' ||
            existing.requestFingerprint !== fingerprint
          )
            throw new DomainError('conflict');
          return existing;
        }
        const community = await persistence.communities.findById(communityId);
        const target = await persistence.memberships.findByCommunityAndAccount(
          communityId,
          targetAccountId,
        );
        if (
          !community ||
          community.archivedAt ||
          community.ownerId === targetAccountId ||
          !target
        )
          throw new DomainError('not_found');
        await this.assertModerationHierarchy(
          actorId,
          targetAccountId,
          communityId,
          'moderation.ban',
        );
        const createdAt = new Date().toISOString();
        const restriction = await persistence.moderationRestrictions.create({
          id: randomUUID(),
          communityId,
          actorId,
          targetAccountId,
          kind: 'ban',
          reason,
          requestFingerprint: fingerprint,
          idempotencyKey: key,
          correlationId,
          createdAt,
          expiresAt:
            durationSeconds === null
              ? null
              : new Date(
                  new Date(createdAt).getTime() + durationSeconds * 1000,
                ).toISOString(),
          revokedAt: null,
          version: 1,
        });
        await this.writeModerationAudit(persistence, {
          communityId,
          actorId,
          targetAccountId,
          action: 'member.ban',
          outcome: 'succeeded',
          reason,
          correlationId,
          metadata: {
            durationSeconds,
            restrictionId: restriction.id,
          },
        });
        return restriction;
      });
    } catch (error) {
      await this.writeRejectedModerationAudit({
        communityId,
        actorId,
        targetAccountId,
        action: 'member.ban',
        reason,
        correlationId,
      });
      throw error;
    }
  }

  async reverseRestriction(
    actorId: string,
    restrictionId: string,
    reasonValue: string,
    expectedVersion: number,
    correlationId: string,
  ): Promise<ModerationRestriction> {
    const reason = moderationReason(reasonValue);
    return this.persistence.transaction(async (persistence) => {
      const current =
        await persistence.moderationRestrictions.findById(restrictionId);
      if (!current) throw new DomainError('not_found');
      await this.assertModerationHierarchy(
        actorId,
        current.targetAccountId,
        current.communityId,
        current.kind === 'ban' ? 'moderation.ban' : 'moderation.timeout',
      );
      if (current.revokedAt) return current;
      const reversed = await persistence.moderationRestrictions.revoke(
        current.id,
        expectedVersion,
        new Date().toISOString(),
      );
      if (!reversed) throw new DomainError('stale_write');
      await this.writeModerationAudit(persistence, {
        communityId: current.communityId,
        actorId,
        targetAccountId: current.targetAccountId,
        action: `member.${current.kind}.reverse`,
        outcome: 'succeeded',
        reason,
        correlationId,
        metadata: { restrictionId },
      });
      return reversed;
    });
  }

  async moderatorDeleteMessage(
    actorId: string,
    messageId: string,
    reasonValue: string,
    keyValue: string,
    expectedVersion: number,
    correlationId: string,
  ): Promise<{ message: Message; deletion: ModerationMessageDeletion }> {
    const reason = moderationReason(reasonValue);
    const key = idempotencyKey(keyValue);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ messageId, reason, expectedVersion }))
      .digest('hex');
    const initial = await this.persistence.messages.findById(messageId);
    if (!initial) throw new DomainError('not_found');
    const initialSpace = await this.persistence.spaces.findById(
      initial.spaceId,
    );
    if (!initialSpace || initialSpace.archivedAt)
      throw new DomainError('not_found');
    await this.assertModerationHierarchy(
      actorId,
      initial.authorId,
      initialSpace.communityId,
      'moderation.message.delete',
    );
    return this.persistence.transaction(async (persistence) => {
      const existing =
        await persistence.moderationMessageDeletions.findByIdempotencyKey(
          actorId,
          messageId,
          key,
        );
      if (existing) {
        if (existing.requestFingerprint !== fingerprint)
          throw new DomainError('conflict');
        const tombstone = await persistence.messages.findById(messageId);
        if (!tombstone) throw new DomainError('not_found');
        return { message: tombstone, deletion: existing };
      }
      const message = await persistence.messages.findById(messageId);
      if (!message || message.deletedAt || message.body === null)
        throw new DomainError('not_found');
      const space = await persistence.spaces.findById(message.spaceId);
      if (!space || space.archivedAt) throw new DomainError('not_found');
      await this.assertModerationHierarchy(
        actorId,
        message.authorId,
        space.communityId,
        'moderation.message.delete',
      );
      const createdAt = new Date().toISOString();
      const evidence = await persistence.moderationMessageEvidence.create({
        id: randomUUID(),
        communityId: space.communityId,
        messageId,
        bodySnapshot: message.body,
        contentHash: createHash('sha256').update(message.body).digest('hex'),
        capturedAt: createdAt,
        retainedUntil: new Date(
          new Date(createdAt).getTime() + 180 * 86_400_000,
        ).toISOString(),
        legalHold: false,
      });
      const tombstone = await persistence.messages.tombstone(
        messageId,
        expectedVersion,
        createdAt,
      );
      if (!tombstone) throw new DomainError('stale_write');
      const deletion = await persistence.moderationMessageDeletions.create({
        id: randomUUID(),
        communityId: space.communityId,
        messageId,
        actorId,
        targetAccountId: message.authorId,
        evidenceId: evidence.id,
        reason,
        requestFingerprint: fingerprint,
        idempotencyKey: key,
        correlationId,
        eventId: randomUUID(),
        createdAt,
      });
      await this.writeModerationAudit(persistence, {
        communityId: space.communityId,
        actorId,
        targetAccountId: message.authorId,
        targetMessageId: messageId,
        action: 'message.delete',
        outcome: 'succeeded',
        reason,
        correlationId,
        metadata: {
          deletionId: deletion.id,
          evidenceId: evidence.id,
          messageId,
        },
      });
      return { message: tombstone, deletion };
    });
  }

  async createSafetyReport(
    reporterId: string,
    communityId: string,
    input: {
      targetAccountId?: string | null;
      targetMessageId?: string | null;
      category: SafetyReportCategory;
      description: string;
      evidenceReferenceIds?: string[];
      idempotencyKey: string;
      correlationId: string;
    },
  ): Promise<SafetyReport> {
    const description = reportDescription(input.description);
    const key = idempotencyKey(input.idempotencyKey);
    const targetAccountId = input.targetAccountId ?? null;
    const targetMessageId = input.targetMessageId ?? null;
    if ((targetAccountId === null) === (targetMessageId === null))
      throw new DomainError('conflict');
    const evidenceReferenceIds = [...new Set(input.evidenceReferenceIds ?? [])];
    if (
      evidenceReferenceIds.length > 10 ||
      evidenceReferenceIds.some(
        (id) =>
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            id,
          ),
      )
    )
      throw new DomainError('conflict');
    await this.enforce(reporterId, 'community.view', [
      { type: 'community', id: communityId },
    ]);
    const existing = await this.persistence.safetyReports.findByIdempotencyKey(
      reporterId,
      communityId,
      key,
    );
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          targetAccountId,
          targetMessageId,
          category: input.category,
          description,
          evidenceReferenceIds,
        }),
      )
      .digest('hex');
    if (existing) {
      if (existing.requestFingerprint !== fingerprint)
        throw new DomainError('conflict');
      return existing;
    }
    if (!(await this.reportLimiter.consume(`report:${reporterId}`, new Date())))
      throw new DomainError('rate_limited', 3600);
    return this.persistence.transaction(async (persistence) => {
      await this.enforce(reporterId, 'community.view', [
        { type: 'community', id: communityId },
      ]);
      const retried = await persistence.safetyReports.findByIdempotencyKey(
        reporterId,
        communityId,
        key,
      );
      if (retried) {
        if (retried.requestFingerprint !== fingerprint)
          throw new DomainError('conflict');
        return retried;
      }
      if (targetMessageId) {
        const message = await persistence.messages.findById(targetMessageId);
        const space = message
          ? await persistence.spaces.findById(message.spaceId)
          : undefined;
        if (!message || !space || space.communityId !== communityId)
          throw new DomainError('not_found');
      } else if (
        !targetAccountId ||
        !(await persistence.memberships.findByCommunityAndAccount(
          communityId,
          targetAccountId,
        ))
      )
        throw new DomainError('not_found');
      const createdAt = new Date().toISOString();
      const report = await persistence.safetyReports.create({
        id: randomUUID(),
        communityId,
        reporterId,
        targetAccountId,
        targetMessageId,
        category: input.category,
        description,
        evidenceReferenceIds,
        status: 'submitted',
        requestFingerprint: fingerprint,
        idempotencyKey: key,
        correlationId: input.correlationId,
        createdAt,
        updatedAt: createdAt,
        version: 1,
      });
      await this.writeModerationAudit(persistence, {
        communityId,
        actorId: reporterId,
        targetAccountId,
        targetMessageId,
        action: 'report.create',
        outcome: 'succeeded',
        reason: null,
        correlationId: input.correlationId,
        metadata: { reportId: report.id, category: report.category },
      });
      return report;
    });
  }

  async getOwnSafetyReport(
    reporterId: string,
    reportId: string,
  ): Promise<SafetyReport> {
    const report = await this.persistence.safetyReports.findById(reportId);
    if (!report || report.reporterId !== reporterId)
      throw new DomainError('not_found');
    await this.enforce(reporterId, 'community.view', [
      { type: 'community', id: report.communityId },
    ]);
    return report;
  }

  async openModerationCase(
    actorId: string,
    reportId: string,
    keyValue: string,
    correlationId: string,
  ): Promise<ModerationCase> {
    const key = idempotencyKey(keyValue);
    const report = await this.persistence.safetyReports.findById(reportId);
    if (!report) throw new DomainError('not_found');
    await this.enforce(actorId, 'moderation.case', [
      { type: 'community', id: report.communityId },
    ]);
    return this.persistence.transaction(async (persistence) => {
      const existing = await persistence.moderationCases.findByIdempotencyKey(
        report.communityId,
        key,
      );
      if (existing) {
        if (existing.reportId !== reportId) throw new DomainError('conflict');
        return existing;
      }
      await this.enforce(actorId, 'moderation.case', [
        { type: 'community', id: report.communityId },
      ]);
      const currentReport = await persistence.safetyReports.findById(reportId);
      if (!currentReport || currentReport.communityId !== report.communityId)
        throw new DomainError('not_found');
      const now = new Date().toISOString();
      const moderationCase = await persistence.moderationCases.create({
        id: randomUUID(),
        communityId: report.communityId,
        reportId,
        assigneeId: null,
        status: 'open',
        idempotencyKey: key,
        correlationId,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        version: 1,
      });
      await persistence.moderationCaseActivity.create({
        id: randomUUID(),
        caseId: moderationCase.id,
        actorId,
        kind: 'opened',
        note: null,
        linkedActionId: null,
        occurredAt: now,
      });
      return moderationCase;
    });
  }

  async updateModerationCase(
    actorId: string,
    caseId: string,
    input: {
      assigneeId?: string | null;
      status?: ModerationCase['status'];
      note?: string;
      linkedActionId?: string;
      expectedVersion: number;
    },
  ): Promise<ModerationCase> {
    return this.persistence.transaction(async (persistence) => {
      const current = await persistence.moderationCases.findById(caseId);
      if (!current) throw new DomainError('not_found');
      await this.enforce(actorId, 'moderation.case', [
        { type: 'community', id: current.communityId },
      ]);
      if (current.status === 'closed') throw new DomainError('conflict');
      const assigneeId =
        input.assigneeId === undefined ? current.assigneeId : input.assigneeId;
      if (assigneeId) {
        const member = await persistence.memberships.findByCommunityAndAccount(
          current.communityId,
          assigneeId,
        );
        if (!member || member.status !== 'active')
          throw new DomainError('not_found');
      }
      const status = input.status ?? current.status;
      const now = new Date().toISOString();
      const updated = await persistence.moderationCases.update(
        caseId,
        {
          assigneeId,
          status,
          updatedAt: now,
          closedAt: status === 'closed' ? now : current.closedAt,
        },
        input.expectedVersion,
      );
      if (!updated) throw new DomainError('stale_write');
      const activities: ModerationCaseActivity[] = [];
      if (assigneeId !== current.assigneeId)
        activities.push({
          id: randomUUID(),
          caseId,
          actorId,
          kind: 'assigned',
          note: null,
          linkedActionId: null,
          occurredAt: now,
        });
      if (status !== current.status)
        activities.push({
          id: randomUUID(),
          caseId,
          actorId,
          kind: 'status_changed',
          note: null,
          linkedActionId: null,
          occurredAt: now,
        });
      if (input.note)
        activities.push({
          id: randomUUID(),
          caseId,
          actorId,
          kind: 'note',
          note: caseNote(input.note),
          linkedActionId: null,
          occurredAt: now,
        });
      if (input.linkedActionId)
        activities.push({
          id: randomUUID(),
          caseId,
          actorId,
          kind: 'action_linked',
          note: null,
          linkedActionId: input.linkedActionId,
          occurredAt: now,
        });
      for (const [index, activity] of activities.entries())
        await persistence.moderationCaseActivity.create({
          ...activity,
          occurredAt: new Date(new Date(now).getTime() + index).toISOString(),
        });
      return updated;
    });
  }

  async getModerationCase(actorId: string, caseId: string) {
    const moderationCase =
      await this.persistence.moderationCases.findById(caseId);
    if (!moderationCase) throw new DomainError('not_found');
    await this.enforce(actorId, 'moderation.case', [
      { type: 'community', id: moderationCase.communityId },
    ]);
    const report = await this.persistence.safetyReports.findById(
      moderationCase.reportId,
    );
    if (!report) throw new DomainError('not_found');
    return {
      case: moderationCase,
      report,
      activity: await this.persistence.moderationCaseActivity.list(caseId),
    };
  }

  async listModerationCases(
    actorId: string,
    communityId: string,
    input: ListPage,
  ): Promise<Page<ModerationCase>> {
    await this.enforce(actorId, 'moderation.case', [
      { type: 'community', id: communityId },
    ]);
    return this.persistence.moderationCases.list(communityId, page(input));
  }

  async submitModerationAppeal(
    appellantId: string,
    restrictionId: string,
    statementValue: string,
    keyValue: string,
    correlationId: string,
  ): Promise<ModerationAppeal> {
    const statement = caseNote(statementValue);
    const key = idempotencyKey(keyValue);
    return this.persistence.transaction(async (persistence) => {
      const retried = await persistence.moderationAppeals.findByIdempotencyKey(
        appellantId,
        key,
      );
      if (retried) {
        if (
          retried.restrictionId !== restrictionId ||
          retried.statement !== statement
        )
          throw new DomainError('conflict');
        return retried;
      }
      const restriction =
        await persistence.moderationRestrictions.findById(restrictionId);
      if (!restriction || restriction.targetAccountId !== appellantId)
        throw new DomainError('not_found');
      if (
        new Date().getTime() - new Date(restriction.createdAt).getTime() >
        30 * 86_400_000
      )
        throw new DomainError('conflict');
      const existing =
        await persistence.moderationAppeals.findByRestrictionId(restrictionId);
      if (existing) throw new DomainError('conflict');
      const now = new Date().toISOString();
      return persistence.moderationAppeals.create({
        id: randomUUID(),
        communityId: restriction.communityId,
        appellantId,
        restrictionId,
        statement,
        status: 'submitted',
        reviewerId: null,
        decisionReason: null,
        idempotencyKey: key,
        correlationId,
        createdAt: now,
        decidedAt: null,
        version: 1,
      });
    });
  }

  async decideModerationAppeal(
    reviewerId: string,
    appealId: string,
    decision: 'upheld' | 'overturned',
    reasonValue: string,
    expectedVersion: number,
    correlationId: string,
  ): Promise<ModerationAppeal> {
    const reason = caseNote(reasonValue);
    return this.persistence.transaction(async (persistence) => {
      const appeal = await persistence.moderationAppeals.findById(appealId);
      if (!appeal) throw new DomainError('not_found');
      await this.enforce(reviewerId, 'moderation.appeal', [
        { type: 'community', id: appeal.communityId },
      ]);
      if (appeal.status !== 'submitted') return appeal;
      const restriction = await persistence.moderationRestrictions.findById(
        appeal.restrictionId,
      );
      if (!restriction) throw new DomainError('not_found');
      if (this.appealReviewerSeparation && restriction.actorId === reviewerId)
        throw new DomainError('forbidden');
      const now = new Date().toISOString();
      if (decision === 'overturned' && !restriction.revokedAt) {
        const restored = await persistence.moderationRestrictions.revoke(
          restriction.id,
          restriction.version,
          now,
        );
        if (!restored) throw new DomainError('stale_write');
      }
      const decided = await persistence.moderationAppeals.decide(
        appeal.id,
        decision,
        reviewerId,
        reason,
        now,
        expectedVersion,
      );
      if (!decided) throw new DomainError('stale_write');
      await this.writeModerationAudit(persistence, {
        communityId: appeal.communityId,
        actorId: reviewerId,
        targetAccountId: appeal.appellantId,
        action: `appeal.${decision}`,
        outcome: 'succeeded',
        reason,
        correlationId,
        metadata: { appealId, restrictionId: restriction.id },
      });
      return decided;
    });
  }

  async getOwnModerationAppeal(appellantId: string, appealId: string) {
    const appeal = await this.persistence.moderationAppeals.findById(appealId);
    if (!appeal || appeal.appellantId !== appellantId)
      throw new DomainError('not_found');
    return appeal;
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
      slowModeSeconds: 0,
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
      slowModeSeconds?: number | undefined;
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
          slowModeSeconds:
            input.slowModeSeconds === undefined
              ? current.slowModeSeconds
              : slowMode(input.slowModeSeconds),
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
    const normalizedBody = messageBody(body);
    const limits = await this.getContentLimits(authorId, space.communityId);
    if (normalizedBody.length > limits.messageBodyMax)
      throw new DomainError('conflict');
    const normalizedKey = idempotencyKey(key);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ body: normalizedBody, replyToId }))
      .digest('hex');
    const existing = await this.persistence.messages.findByIdempotencyKey(
      authorId,
      spaceId,
      normalizedKey,
    );
    if (existing) {
      if (existing.requestFingerprint !== fingerprint)
        throw new DomainError('conflict');
      return existing;
    }
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
      if (retried) {
        if (retried.requestFingerprint !== fingerprint)
          throw new DomainError('conflict');
        return retried;
      }
      const now = new Date().toISOString();
      const community = await persistence.communities.findById(
        space.communityId,
      );
      const bypass = community?.ownerId === authorId;
      if (!bypass && space.slowModeSeconds > 0) {
        const retryAfter = await persistence.messagePacing.consume(
          space.id,
          authorId,
          space.slowModeSeconds,
          now,
        );
        if (retryAfter > 0) throw new DomainError('rate_limited', retryAfter);
      }
      return persistence.messages.create({
        id: randomUUID(),
        spaceId,
        authorId,
        body: normalizedBody,
        replyToId,
        idempotencyKey: normalizedKey,
        requestFingerprint: fingerprint,
        createdEventId: randomUUID(),
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
  async listReactions(
    messageId: string,
    actorId: string,
  ): Promise<ReactionAggregate[]> {
    const message = await this.messageForMutation(messageId, actorId, false);
    return this.persistence.reactions.list(message.id, actorId);
  }
  async addReaction(
    messageId: string,
    actorId: string,
    key: string,
  ): Promise<ReactionAggregate[]> {
    const normalized = reactionKey(key);
    return this.persistence.transaction(async (persistence) => {
      const message = await this.messageForMutation(messageId, actorId, false);
      await persistence.reactions.add({
        messageId: message.id,
        actorId,
        key: normalized,
        createdAt: new Date().toISOString(),
      });
      return persistence.reactions.list(message.id, actorId);
    });
  }
  async removeReaction(
    messageId: string,
    actorId: string,
    key: string,
  ): Promise<ReactionAggregate[]> {
    const normalized = reactionKey(key);
    return this.persistence.transaction(async (persistence) => {
      const message = await this.messageForMutation(messageId, actorId, false);
      await persistence.reactions.remove(message.id, actorId, normalized);
      return persistence.reactions.list(message.id, actorId);
    });
  }

  private async messageForMutation(
    id: string,
    actorId: string,
    requireAuthor: boolean,
  ): Promise<Message> {
    const message = await this.persistence.messages.findById(id);
    if (!message) throw new DomainError('not_found');
    const space = await this.persistence.spaces.findById(message.spaceId);
    if (!space || space.archivedAt) throw new DomainError('not_found');
    await this.authorizeSpaceSubscription(space.id, actorId);
    if (requireAuthor && message.authorId !== actorId)
      throw new DomainError('forbidden');
    return message;
  }
  async createInvitation(
    actorId: string,
    communityId: string,
    input: {
      expiresInSeconds: number;
      maxUses: number;
      targetAccountId?: string | null;
    },
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
          this.audit(actorId, communityId, invitation.id, 'invitation.create'),
        );
      });
      return { invitation, token };
    } catch (error) {
      await this.rejectedAudit(actorId, communityId, 'invitation.create');
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
  async revokeInvitation(
    actorId: string,
    invitationId: string,
    expectedVersion: number,
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
            invitation.id,
            'invitation.revoke',
          ),
        );
        return revoked;
      });
    } catch (error) {
      await this.rejectedAudit(actorId, communityId, 'invitation.revoke');
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
  ): Promise<Membership> {
    await this.limitInvitation(`accept:${source}`);
    let tokenHash: string;
    try {
      tokenHash = protectInvitationToken(token);
    } catch {
      throw new DomainError('invitation_unavailable');
    }
    return this.persistence.transaction(async (persistence) => {
      const invitation =
        await persistence.invitations.findByTokenHash(tokenHash);
      if (
        !invitation ||
        (invitation.targetAccountId && invitation.targetAccountId !== actorId)
      )
        throw new DomainError('invitation_unavailable');
      const existing = await persistence.memberships.findByCommunityAndAccount(
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
      if (
        await persistence.moderationRestrictions.findEffective(
          invitation.communityId,
          actorId,
          now,
        )
      )
        throw new DomainError('invitation_unavailable');
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
          invitation.id,
          'invitation.accept',
        ),
      );
      return membership;
    });
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
    invitationId: string | null,
    action: AuditEvent['action'],
    outcome: AuditEvent['outcome'] = 'succeeded',
  ): AuditEvent {
    return {
      id: randomUUID(),
      actorId,
      communityId,
      invitationId,
      action,
      outcome,
      occurredAt: new Date().toISOString(),
    };
  }
  private async rejectedAudit(
    actorId: string,
    communityId: string | null,
    action: 'invitation.create' | 'invitation.revoke',
  ): Promise<void> {
    try {
      await this.persistence.auditEvents.create(
        this.audit(actorId, communityId, null, action, 'rejected'),
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
  private async assertModerationHierarchy(
    actorId: string,
    targetAccountId: string,
    communityId: string,
    permission:
      'moderation.timeout' | 'moderation.ban' | 'moderation.message.delete',
  ): Promise<void> {
    if (this.authorization?.assertCanModerate) {
      await this.authorization.assertCanModerate(
        actorId,
        targetAccountId,
        communityId,
        permission,
      );
      return;
    }
    const community = await this.persistence.communities.findById(communityId);
    if (
      !community ||
      community.ownerId !== actorId ||
      actorId === targetAccountId
    )
      throw new DomainError('forbidden');
    await this.enforce(actorId, permission, [
      { type: 'community', id: communityId },
    ]);
  }

  private async writeModerationAudit(
    persistence: Persistence,
    input: {
      communityId: string;
      actorId: string;
      targetAccountId: string | null;
      targetMessageId?: string | null;
      action: string;
      outcome: 'succeeded' | 'rejected';
      reason: string | null;
      correlationId: string;
      metadata?: Record<string, string | number | boolean | null>;
    },
  ): Promise<void> {
    const occurredAt = new Date().toISOString();
    const previousHash =
      (await persistence.moderationAuditEvents.latestHash(input.communityId)) ??
      null;
    const material = JSON.stringify({
      ...input,
      metadata: input.metadata ?? {},
      occurredAt,
      previousHash,
    });
    await persistence.moderationAuditEvents.create({
      id: randomUUID(),
      ...input,
      targetMessageId: input.targetMessageId ?? null,
      occurredAt,
      previousHash,
      eventHash: createHash('sha256').update(material).digest('hex'),
      metadata: input.metadata ?? {},
    });
  }

  private async writeRejectedModerationAudit(
    input: Omit<
      Parameters<CommunityService['writeModerationAudit']>[1],
      'outcome'
    >,
  ): Promise<void> {
    try {
      await this.writeModerationAudit(this.persistence, {
        ...input,
        outcome: 'rejected',
      });
    } catch {
      // Audit failure must not replace or disclose the original denial.
    }
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
    if (
      communityId &&
      !permission.startsWith('moderation.') &&
      (await this.persistence.moderationRestrictions.findEffective(
        communityId,
        actorId,
        new Date().toISOString(),
      ))
    )
      throw new DomainError('forbidden');
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
    if (
      community.ownerId !== actorId &&
      (permission.endsWith('.manage') ||
        permission.startsWith('moderation.') ||
        permission === 'community.manage')
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
  reactions: Map<string, MessageReaction>;
  messagePacing: Map<string, number>;
  sessions: Map<string, SessionRecord>;
  invitations: Map<string, Invitation>;
  auditEvents: Map<string, AuditEvent>;
  moderationRestrictions: Map<string, ModerationRestriction>;
  moderationAuditEvents: Map<string, ModerationAuditEvent>;
  moderationMessageEvidence: Map<string, ModerationMessageEvidence>;
  moderationMessageDeletions: Map<string, ModerationMessageDeletion>;
  safetyReports: Map<string, SafetyReport>;
  moderationCases: Map<string, ModerationCase>;
  moderationCaseActivity: Map<string, ModerationCaseActivity>;
  moderationAppeals: Map<string, ModerationAppeal>;
  contentLimits: Map<string, CommunityContentLimits>;
};
const clone = (state: MemoryState): MemoryState => ({
  accounts: new Map(state.accounts),
  communities: new Map(state.communities),
  memberships: new Map(state.memberships),
  categories: new Map(state.categories),
  spaces: new Map(state.spaces),
  messages: new Map(state.messages),
  reactions: new Map(state.reactions),
  messagePacing: new Map(state.messagePacing),
  sessions: new Map(state.sessions),
  invitations: new Map(state.invitations),
  auditEvents: new Map(state.auditEvents),
  moderationRestrictions: new Map(state.moderationRestrictions),
  moderationAuditEvents: new Map(state.moderationAuditEvents),
  moderationMessageEvidence: new Map(state.moderationMessageEvidence),
  moderationMessageDeletions: new Map(state.moderationMessageDeletions),
  safetyReports: new Map(state.safetyReports),
  moderationCases: new Map(state.moderationCases),
  moderationCaseActivity: new Map(state.moderationCaseActivity),
  moderationAppeals: new Map(state.moderationAppeals),
  contentLimits: new Map(state.contentLimits),
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
    reactions: new Map(),
    messagePacing: new Map(),
    sessions: new Map(),
    invitations: new Map(),
    auditEvents: new Map(),
    moderationRestrictions: new Map(),
    moderationAuditEvents: new Map(),
    moderationMessageEvidence: new Map(),
    moderationMessageDeletions: new Map(),
    safetyReports: new Map(),
    moderationCases: new Map(),
    moderationCaseActivity: new Map(),
    moderationAppeals: new Map(),
    contentLimits: new Map(),
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
      input: Pick<
        Space,
        'name' | 'position' | 'categoryId' | 'archivedAt' | 'slowModeSeconds'
      >,
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
  readonly reactions = {
    add: async (reaction: MessageReaction) => {
      const key = `${reaction.messageId}:${reaction.actorId}:${reaction.key}`;
      if (this.state.reactions.has(key)) return false;
      this.state.reactions.set(key, reaction);
      return true;
    },
    remove: async (messageId: string, actorId: string, reaction: string) =>
      this.state.reactions.delete(`${messageId}:${actorId}:${reaction}`),
    list: async (messageId: string, actorId: string) => {
      const grouped = new Map<
        string,
        { count: number; reactedByActor: boolean }
      >();
      for (const reaction of this.state.reactions.values()) {
        if (reaction.messageId !== messageId) continue;
        const current = grouped.get(reaction.key) ?? {
          count: 0,
          reactedByActor: false,
        };
        grouped.set(reaction.key, {
          count: current.count + 1,
          reactedByActor:
            current.reactedByActor || reaction.actorId === actorId,
        });
      }
      return [...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, ...value }));
    },
  };
  readonly messagePacing = {
    consume: async (
      spaceId: string,
      actorId: string,
      intervalSeconds: number,
      now: string,
    ) => {
      const key = `${spaceId}:${actorId}`;
      const current = this.state.messagePacing.get(key) ?? 0;
      const timestamp = new Date(now).getTime();
      if (current > timestamp)
        return Math.max(1, Math.ceil((current - timestamp) / 1000));
      this.state.messagePacing.set(key, timestamp + intervalSeconds * 1000);
      return 0;
    },
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
    create: async (v: AuditEvent) => (this.state.auditEvents.set(v.id, v), v),
    list: async (communityId: string) =>
      [...this.state.auditEvents.values()].filter(
        (event) => event.communityId === communityId,
      ),
  };
  readonly moderationRestrictions = {
    create: async (value: ModerationRestriction) => {
      const existing = await this.moderationRestrictions.findByIdempotencyKey(
        value.actorId,
        value.communityId,
        value.idempotencyKey,
      );
      if (existing) return existing;
      this.state.moderationRestrictions.set(value.id, value);
      return value;
    },
    findById: async (id: string) => this.state.moderationRestrictions.get(id),
    findByIdempotencyKey: async (
      actorId: string,
      communityId: string,
      key: string,
    ) =>
      [...this.state.moderationRestrictions.values()].find(
        (value) =>
          value.actorId === actorId &&
          value.communityId === communityId &&
          value.idempotencyKey === key,
      ),
    findEffective: async (
      communityId: string,
      accountId: string,
      now: string,
    ) =>
      [...this.state.moderationRestrictions.values()]
        .filter(
          (value) =>
            value.communityId === communityId &&
            value.targetAccountId === accountId &&
            !value.revokedAt &&
            (value.expiresAt === null || value.expiresAt > now),
        )
        .sort((left, right) =>
          (right.expiresAt ?? '9999').localeCompare(left.expiresAt ?? '9999'),
        )[0],
    revoke: async (id: string, version: number, revokedAt: string) =>
      this.updateMap(
        this.state.moderationRestrictions,
        id,
        version,
        (value) => ({
          ...value,
          revokedAt: value.revokedAt ?? revokedAt,
        }),
      ),
  };
  readonly moderationAuditEvents = {
    create: async (value: ModerationAuditEvent) => {
      this.state.moderationAuditEvents.set(value.id, value);
      return value;
    },
    latestHash: async (communityId: string) =>
      [...this.state.moderationAuditEvents.values()]
        .filter((value) => value.communityId === communityId)
        .sort(
          (left, right) =>
            right.occurredAt.localeCompare(left.occurredAt) ||
            right.id.localeCompare(left.id),
        )[0]?.eventHash,
  };
  readonly moderationMessageEvidence = {
    create: async (value: ModerationMessageEvidence) => {
      const existing = [...this.state.moderationMessageEvidence.values()].find(
        (candidate) => candidate.messageId === value.messageId,
      );
      if (existing) return existing;
      this.state.moderationMessageEvidence.set(value.id, value);
      return value;
    },
  };
  readonly moderationMessageDeletions = {
    create: async (value: ModerationMessageDeletion) => {
      const existing =
        await this.moderationMessageDeletions.findByIdempotencyKey(
          value.actorId,
          value.messageId,
          value.idempotencyKey,
        );
      if (existing) return existing;
      this.state.moderationMessageDeletions.set(value.id, value);
      return value;
    },
    findByIdempotencyKey: async (
      actorId: string,
      messageId: string,
      key: string,
    ) =>
      [...this.state.moderationMessageDeletions.values()].find(
        (value) =>
          value.actorId === actorId &&
          value.messageId === messageId &&
          value.idempotencyKey === key,
      ),
  };
  readonly safetyReports = {
    create: async (value: SafetyReport) => {
      const existing = await this.safetyReports.findByIdempotencyKey(
        value.reporterId,
        value.communityId,
        value.idempotencyKey,
      );
      if (existing) return existing;
      this.state.safetyReports.set(value.id, value);
      return value;
    },
    findById: async (id: string) => this.state.safetyReports.get(id),
    findByIdempotencyKey: async (
      reporterId: string,
      communityId: string,
      key: string,
    ) =>
      [...this.state.safetyReports.values()].find(
        (value) =>
          value.reporterId === reporterId &&
          value.communityId === communityId &&
          value.idempotencyKey === key,
      ),
  };
  readonly moderationCases = {
    create: async (value: ModerationCase) => {
      const duplicateReport = [...this.state.moderationCases.values()].find(
        (candidate) => candidate.reportId === value.reportId,
      );
      if (duplicateReport) return duplicateReport;
      this.state.moderationCases.set(value.id, value);
      return value;
    },
    findById: async (id: string) => this.state.moderationCases.get(id),
    findByIdempotencyKey: async (communityId: string, key: string) =>
      [...this.state.moderationCases.values()].find(
        (value) =>
          value.communityId === communityId && value.idempotencyKey === key,
      ),
    list: async (communityId: string, input: ListPage) => {
      const values = [...this.state.moderationCases.values()]
        .filter((value) => value.communityId === communityId)
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            right.id.localeCompare(left.id),
        )
        .filter((value) => !input.cursor || value.id < after(input.cursor));
      const items = values.slice(0, input.limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          values.length > input.limit && last ? cursor(last.id) : null,
      };
    },
    update: async (
      id: string,
      input: Pick<
        ModerationCase,
        'assigneeId' | 'status' | 'closedAt' | 'updatedAt'
      >,
      version: number,
    ) =>
      this.updateMap(this.state.moderationCases, id, version, (value) => ({
        ...value,
        ...input,
      })),
  };
  readonly moderationCaseActivity = {
    create: async (value: ModerationCaseActivity) => {
      this.state.moderationCaseActivity.set(value.id, value);
      return value;
    },
    list: async (caseId: string) =>
      [...this.state.moderationCaseActivity.values()]
        .filter((value) => value.caseId === caseId)
        .sort(
          (left, right) =>
            left.occurredAt.localeCompare(right.occurredAt) ||
            left.id.localeCompare(right.id),
        ),
  };
  readonly moderationAppeals = {
    create: async (value: ModerationAppeal) => {
      const existing = [...this.state.moderationAppeals.values()].find(
        (candidate) => candidate.restrictionId === value.restrictionId,
      );
      if (existing) return existing;
      this.state.moderationAppeals.set(value.id, value);
      return value;
    },
    findById: async (id: string) => this.state.moderationAppeals.get(id),
    findByRestrictionId: async (restrictionId: string) =>
      [...this.state.moderationAppeals.values()].find(
        (value) => value.restrictionId === restrictionId,
      ),
    findByIdempotencyKey: async (appellantId: string, key: string) =>
      [...this.state.moderationAppeals.values()].find(
        (value) =>
          value.appellantId === appellantId && value.idempotencyKey === key,
      ),
    decide: async (
      id: string,
      status: 'upheld' | 'overturned',
      reviewerId: string,
      reason: string,
      decidedAt: string,
      version: number,
    ) =>
      this.updateMap(this.state.moderationAppeals, id, version, (value) => ({
        ...value,
        status,
        reviewerId,
        decisionReason: reason,
        decidedAt,
      })),
  };
  readonly contentLimits = {
    find: async (communityId: string) =>
      this.state.contentLimits.get(communityId),
    put: async (value: CommunityContentLimits, expectedVersion?: number) => {
      const current = this.state.contentLimits.get(value.communityId);
      if (
        (current && current.version !== expectedVersion) ||
        (!current && expectedVersion !== undefined)
      )
        return undefined;
      this.state.contentLimits.set(value.communityId, value);
      return value;
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
