import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from 'pg';
import type {
  Account,
  AuditEvent,
  ModerationRestriction,
  ModerationAuditEvent,
  ModerationMessageEvidence,
  ModerationMessageDeletion,
  SafetyReport,
  ModerationCase,
  ModerationCaseActivity,
  ModerationAppeal,
  CommunityContentLimits,
  Category,
  Community,
  Invitation,
  Membership,
  Message,
  Persistence,
  SessionRecord,
  Space,
  NotificationRecord,
  NotificationStore,
  NotificationAuthorization,
  NotificationPreference,
  NotificationPreferenceAuthorization,
  NotificationPreferenceStore,
  NotificationReadAuthorization,
  NotificationReadState,
  NotificationReadStore,
} from '@nexa/domain';
import type { AuthAccount, AuthSession, AuthStore } from '@nexa/auth';
import {
  StaleAuthorizationWriteError,
  type AuthorizationSnapshot,
  type AuthorizationStore,
  type Permission,
  type Role,
  type RoleAssignment,
  type ScopeType,
  type ScopedDecision,
} from '@nexa/authorization';

export const CURRENT_SCHEMA_VERSION = 39;
const MIGRATION_LOCK_ID = 1_318_611_193;

export interface PostgresConfig {
  connectionString: string;
  maxConnections: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  queryTimeoutMs: number;
  migrationsDirectory: string;
}

export function createPostgresPool(config: PostgresConfig): Pool {
  const poolConfig: PoolConfig = {
    connectionString: config.connectionString,
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    application_name: 'nexa-chat',
    options: '-c timezone=UTC',
  };
  const pool = new Pool(poolConfig);
  pool.on('error', (error) => {
    const code =
      typeof (error as Error & { code?: unknown }).code === 'string'
        ? (error as Error & { code: string }).code
        : 'unknown';
    console.error(JSON.stringify({ event: 'postgres.pool.error', code }));
  });
  return pool;
}

interface Queryable {
  // The row type binds each statement to its explicit result mapping.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export class PostgresPersistence implements Persistence {
  readonly accounts;
  readonly communities;
  readonly memberships;
  readonly categories;
  readonly spaces;
  readonly messages;
  readonly reactions;
  readonly messagePacing;
  readonly sessions;
  readonly invitations;
  readonly auditEvents;
  readonly moderationRestrictions;
  readonly moderationAuditEvents;
  readonly moderationMessageEvidence;
  readonly moderationMessageDeletions;
  readonly safetyReports;
  readonly moderationCases;
  readonly moderationCaseActivity;
  readonly moderationAppeals;
  readonly contentLimits;

  constructor(
    private readonly pool: Pool,
    private readonly queryable: Queryable = pool,
  ) {
    this.accounts = accountRepository(queryable);
    this.communities = communityRepository(queryable);
    this.memberships = membershipRepository(queryable);
    this.categories = categoryRepository(queryable);
    this.spaces = spaceRepository(queryable);
    this.messages = messageRepository(queryable);
    this.reactions = reactionRepository(queryable);
    this.messagePacing = messagePacingRepository(queryable);
    this.sessions = sessionRepository(queryable);
    this.invitations = invitationRepository(queryable);
    this.auditEvents = auditEventRepository(queryable);
    this.moderationRestrictions = moderationRestrictionRepository(queryable);
    this.moderationAuditEvents = moderationAuditRepository(queryable);
    this.moderationMessageEvidence =
      moderationMessageEvidenceRepository(queryable);
    this.moderationMessageDeletions =
      moderationMessageDeletionRepository(queryable);
    this.safetyReports = safetyReportRepository(queryable);
    this.moderationCases = moderationCaseRepository(queryable);
    this.moderationCaseActivity = moderationCaseActivityRepository(queryable);
    this.moderationAppeals = moderationAppealRepository(queryable);
    this.contentLimits = contentLimitsRepository(queryable);
  }

  async transaction<T>(
    work: (persistence: Persistence) => Promise<T>,
  ): Promise<T> {
    if (this.queryable !== this.pool) return work(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PostgresPersistence(this.pool, client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

interface NotificationRow {
  id: string;
  account_id: string;
  kind: NotificationRecord['kind'];
  scope_id: string | null;
  resource_id: string;
  actor_ids: string[];
  aggregate_count: number;
  deduplication_key: string;
  created_at: Date | string;
  updated_at: Date | string;
  read_at: Date | string | null;
  archived_at: Date | string | null;
  expires_at: Date | string;
  version: number;
}

const NOTIFICATION_FIELDS = `id, account_id, kind, scope_id, resource_id,
  actor_ids, aggregate_count, deduplication_key, created_at, updated_at,
  read_at, archived_at, expires_at, version`;

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

function mapNotification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    scopeId: row.scope_id,
    resourceId: row.resource_id,
    actorIds: row.actor_ids,
    count: row.aggregate_count,
    deduplicationKey: row.deduplication_key,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    readAt: nullableTimestamp(row.read_at),
    archivedAt: nullableTimestamp(row.archived_at),
    expiresAt: timestamp(row.expires_at),
    version: row.version,
  };
}

function notificationCursor(value: NotificationRecord): string {
  return Buffer.from(
    JSON.stringify([value.updatedAt, value.id]),
    'utf8',
  ).toString('base64url');
}

function parseNotificationCursor(value: string): [string, string] {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      !Number.isFinite(Date.parse(parsed[0])) ||
      typeof parsed[1] !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(parsed[1])
    )
      throw new Error('invalid');
    return [parsed[0], parsed[1]];
  } catch {
    throw new Error('invalid_notification_cursor');
  }
}

/** Durable notification adapter. Transactions use serializable isolation and a
 * per-deduplication-key advisory lock so concurrent replicas cannot create the
 * same logical notification twice. */
export class PostgresNotificationStore implements NotificationStore {
  constructor(
    private readonly pool: Pool,
    private readonly db: Pool | PoolClient = pool,
  ) {}

  async findDeduplicated(accountId: string, key: string) {
    await this.db.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${accountId}:${key}`],
    );
    const result = await this.db.query<NotificationRow>(
      `SELECT ${NOTIFICATION_FIELDS} FROM notifications
       WHERE account_id = $1 AND deduplication_key = $2`,
      [accountId, key],
    );
    return result.rows[0] ? mapNotification(result.rows[0]) : undefined;
  }

  async create(value: NotificationRecord): Promise<NotificationRecord> {
    const result = await this.db.query<NotificationRow>(
      `INSERT INTO notifications
       (id, account_id, kind, scope_id, resource_id, actor_ids,
        aggregate_count, deduplication_key, created_at, updated_at, read_at,
        archived_at, expires_at, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${NOTIFICATION_FIELDS}`,
      [
        value.id,
        value.accountId,
        value.kind,
        value.scopeId,
        value.resourceId,
        value.actorIds,
        value.count,
        value.deduplicationKey,
        value.createdAt,
        value.updatedAt,
        value.readAt,
        value.archivedAt,
        value.expiresAt,
        value.version,
      ],
    );
    return mapNotification(requiredRow(result.rows));
  }

  async update(
    id: string,
    expectedVersion: number,
    patch: Partial<NotificationRecord>,
  ) {
    const current = await this.find(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, version: current.version + 1 };
    const result = await this.db.query<NotificationRow>(
      `UPDATE notifications SET actor_ids=$3, aggregate_count=$4,
       updated_at=$5, read_at=$6, archived_at=$7, expires_at=$8,
       version=version+1 WHERE id=$1 AND version=$2
       RETURNING ${NOTIFICATION_FIELDS}`,
      [
        id,
        expectedVersion,
        next.actorIds,
        next.count,
        next.updatedAt,
        next.readAt,
        next.archivedAt,
        next.expiresAt,
      ],
    );
    return result.rows[0] ? mapNotification(result.rows[0]) : undefined;
  }

  async find(id: string) {
    const result = await this.db.query<NotificationRow>(
      `SELECT ${NOTIFICATION_FIELDS} FROM notifications WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapNotification(result.rows[0]) : undefined;
  }

  async list(
    accountId: string,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: NotificationRecord[]; nextCursor: string | null }> {
    const cursor = input.cursor
      ? parseNotificationCursor(input.cursor)
      : undefined;
    const result = await this.db.query<NotificationRow>(
      `SELECT ${NOTIFICATION_FIELDS} FROM notifications
       WHERE account_id=$1 AND expires_at > CURRENT_TIMESTAMP
       AND ($2::timestamptz IS NULL OR (updated_at, id) < ($2, $3::uuid))
       ORDER BY updated_at DESC, id DESC LIMIT $4`,
      [accountId, cursor?.[0] ?? null, cursor?.[1] ?? null, input.limit + 1],
    );
    const mapped = result.rows.map(mapNotification);
    const hasMore = mapped.length > input.limit;
    const items = mapped.slice(0, input.limit);
    return {
      items,
      nextCursor:
        hasMore && items.length > 0
          ? notificationCursor(items[items.length - 1]!)
          : null,
    };
  }

  async transaction<T>(
    work: (store: NotificationStore) => Promise<T>,
  ): Promise<T> {
    if (this.db !== this.pool) return work(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await work(
        new PostgresNotificationStore(this.pool, client),
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Re-checks notification resource visibility against current durable state.
 * The deliberately generic false result prevents callers from distinguishing a
 * deleted resource from a blocked or unauthorized one. */
export class PostgresNotificationAuthorization implements NotificationAuthorization {
  constructor(private readonly db: Pool | PoolClient) {}

  mayNotify(
    accountId: string,
    resourceId: string,
    kind: NotificationRecord['kind'],
  ): Promise<boolean> {
    return this.mayView(accountId, resourceId, kind);
  }

  async mayView(
    accountId: string,
    resourceId: string,
    kind?: NotificationRecord['kind'],
  ): Promise<boolean> {
    if (kind === 'mention' || kind === 'reply') {
      const result = await this.db.query(
        `SELECT 1 FROM messages msg
         JOIN spaces s ON s.id=msg.space_id AND s.archived_at IS NULL
         JOIN memberships m ON m.community_id=s.community_id
           AND m.account_id=$1 AND m.status='active'
         WHERE msg.id=$2 AND msg.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM account_blocks b
             WHERE (b.blocker_id=$1 AND b.blocked_id=msg.author_id)
                OR (b.blocker_id=msg.author_id AND b.blocked_id=$1)
           ) LIMIT 1`,
        [accountId, resourceId],
      );
      return result.rows.length === 1;
    }
    if (kind === 'invite') {
      const result = await this.db.query(
        `SELECT 1 FROM invitations i JOIN communities c ON c.id=i.community_id
         WHERE i.id=$2 AND i.target_account_id=$1 AND i.revoked_at IS NULL
           AND i.expires_at > CURRENT_TIMESTAMP AND c.archived_at IS NULL
         LIMIT 1`,
        [accountId, resourceId],
      );
      return result.rows.length === 1;
    }
    if (kind === 'moderation_outcome') {
      const result = await this.db.query(
        `SELECT 1 FROM safety_reports r WHERE r.id=$2 AND r.reporter_id=$1
         UNION ALL
         SELECT 1 FROM moderation_restrictions mr
         WHERE mr.id=$2 AND mr.target_account_id=$1 LIMIT 1`,
        [accountId, resourceId],
      );
      return result.rows.length > 0;
    }
    return false;
  }
}

interface NotificationPreferenceRow {
  account_id: string;
  scope_type: NotificationPreference['scopeType'];
  scope_id: string;
  mode: NotificationPreference['mode'];
  muted_until: Date | string | null;
  updated_at: Date | string;
  version: number;
}

function mapNotificationPreference(
  row: NotificationPreferenceRow,
): NotificationPreference {
  return {
    accountId: row.account_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    mode: row.mode,
    mutedUntil: nullableTimestamp(row.muted_until),
    updatedAt: timestamp(row.updated_at),
    version: row.version,
  };
}

export class PostgresNotificationPreferenceStore implements NotificationPreferenceStore {
  constructor(
    private readonly pool: Pool,
    private readonly db: Pool | PoolClient = pool,
  ) {}

  async find(
    accountId: string,
    scopeType: NotificationPreference['scopeType'],
    scopeId: string,
  ) {
    const result = await this.db.query<NotificationPreferenceRow>(
      `SELECT account_id, scope_type, scope_id, mode, muted_until, updated_at,
       version FROM notification_preferences WHERE account_id=$1
       AND scope_type=$2 AND scope_id=$3`,
      [accountId, scopeType, scopeId],
    );
    return result.rows[0]
      ? mapNotificationPreference(result.rows[0])
      : undefined;
  }

  async save(value: NotificationPreference, expectedVersion?: number) {
    const result =
      expectedVersion === undefined
        ? await this.db.query<NotificationPreferenceRow>(
            `INSERT INTO notification_preferences
             (account_id,scope_type,scope_id,mode,muted_until,updated_at,version)
             VALUES ($1,$2,$3,$4,$5,$6,1)
             ON CONFLICT DO NOTHING RETURNING account_id, scope_type, scope_id,
             mode, muted_until, updated_at, version`,
            [
              value.accountId,
              value.scopeType,
              value.scopeId,
              value.mode,
              value.mutedUntil,
              value.updatedAt,
            ],
          )
        : await this.db.query<NotificationPreferenceRow>(
            `UPDATE notification_preferences SET mode=$5, muted_until=$6,
             updated_at=$7, version=version+1 WHERE account_id=$1
             AND scope_type=$2 AND scope_id=$3 AND version=$4
             RETURNING account_id, scope_type, scope_id, mode, muted_until,
             updated_at, version`,
            [
              value.accountId,
              value.scopeType,
              value.scopeId,
              expectedVersion,
              value.mode,
              value.mutedUntil,
              value.updatedAt,
            ],
          );
    return result.rows[0]
      ? mapNotificationPreference(result.rows[0])
      : undefined;
  }

  async transaction<T>(
    work: (store: NotificationPreferenceStore) => Promise<T>,
  ): Promise<T> {
    if (this.db !== this.pool) return work(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await work(
        new PostgresNotificationPreferenceStore(this.pool, client),
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresNotificationPreferenceAuthorization implements NotificationPreferenceAuthorization {
  constructor(private readonly db: Pool | PoolClient) {}

  async mayConfigure(
    accountId: string,
    scopeType: NotificationPreference['scopeType'],
    scopeId: string,
  ): Promise<boolean> {
    if (scopeType === 'account') return accountId === scopeId;
    const relation =
      scopeType === 'community'
        ? `SELECT id AS community_id FROM communities WHERE id=$2 AND archived_at IS NULL`
        : scopeType === 'category'
          ? `SELECT community_id FROM categories WHERE id=$2 AND archived_at IS NULL`
          : `SELECT community_id FROM spaces WHERE id=$2 AND archived_at IS NULL`;
    const result = await this.db.query(
      `SELECT 1 FROM (${relation}) scope
       JOIN memberships m ON m.community_id=scope.community_id
       WHERE m.account_id=$1 AND m.status='active' LIMIT 1`,
      [accountId, scopeId],
    );
    return result.rows.length === 1;
  }
}

interface NotificationReadRow {
  account_id: string;
  stream: string;
  sequence: string | number;
  event_id: string;
  updated_at: Date | string;
  version: number;
}

function mapNotificationRead(row: NotificationReadRow): NotificationReadState {
  return {
    accountId: row.account_id,
    stream: row.stream,
    sequence: Number(row.sequence),
    eventId: row.event_id,
    updatedAt: timestamp(row.updated_at),
    version: row.version,
  };
}

export class PostgresNotificationReadStore implements NotificationReadStore {
  constructor(
    private readonly pool: Pool,
    private readonly db: Pool | PoolClient = pool,
  ) {}

  async find(accountId: string, stream: string) {
    const result = await this.db.query<NotificationReadRow>(
      `SELECT account_id,stream,sequence,event_id,updated_at,version
       FROM notification_read_state WHERE account_id=$1 AND stream=$2`,
      [accountId, stream],
    );
    return result.rows[0] ? mapNotificationRead(result.rows[0]) : undefined;
  }

  async advance(value: NotificationReadState, expectedVersion?: number) {
    const result =
      expectedVersion === undefined
        ? await this.db.query<NotificationReadRow>(
            `INSERT INTO notification_read_state
             (account_id,stream,sequence,event_id,updated_at,version)
             VALUES ($1,$2,$3,$4,$5,1) ON CONFLICT DO NOTHING
             RETURNING account_id,stream,sequence,event_id,updated_at,version`,
            [
              value.accountId,
              value.stream,
              value.sequence,
              value.eventId,
              value.updatedAt,
            ],
          )
        : await this.db.query<NotificationReadRow>(
            `UPDATE notification_read_state SET sequence=$4,event_id=$5,
             updated_at=$6,version=version+1 WHERE account_id=$1 AND stream=$2
             AND version=$3 AND sequence < $4
             RETURNING account_id,stream,sequence,event_id,updated_at,version`,
            [
              value.accountId,
              value.stream,
              expectedVersion,
              value.sequence,
              value.eventId,
              value.updatedAt,
            ],
          );
    return result.rows[0] ? mapNotificationRead(result.rows[0]) : undefined;
  }

  async transaction<T>(
    work: (store: NotificationReadStore) => Promise<T>,
  ): Promise<T> {
    if (this.db !== this.pool) return work(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await work(
        new PostgresNotificationReadStore(this.pool, client),
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresNotificationReadAuthorization implements NotificationReadAuthorization {
  constructor(private readonly db: Pool | PoolClient) {}

  async mayAccess(accountId: string, stream: string): Promise<boolean> {
    const spaceId = stream.startsWith('space:') ? stream.slice(6) : undefined;
    const result = await this.db.query(
      spaceId
        ? `SELECT 1 FROM accounts a JOIN memberships m ON m.account_id=a.id
           JOIN spaces s ON s.community_id=m.community_id
           WHERE a.id=$1 AND a.status='active' AND m.status='active'
           AND s.id=$2 AND s.archived_at IS NULL LIMIT 1`
        : `SELECT 1 FROM accounts WHERE id=$1 AND status='active' LIMIT 1`,
      spaceId ? [accountId, spaceId] : [accountId],
    );
    return result.rows.length === 1;
  }
}

export class PostgresAuthStore implements AuthStore {
  constructor(
    private readonly pool: Pool,
    private readonly authQueryable: Pool | PoolClient = pool,
  ) {}

  async createAccount(account: AuthAccount): Promise<AuthAccount> {
    const result = await this.authQueryable.query<AuthAccountRow>(
      `INSERT INTO accounts
        (id, display_name, username, normalized_username, password_hash, status,
         credential_version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING ${AUTH_ACCOUNT_FIELDS}`,
      [
        account.id,
        account.displayName,
        account.username,
        account.normalizedUsername,
        account.passwordHash,
        account.status,
        account.credentialVersion,
        account.createdAt,
        account.updatedAt,
      ],
    );
    return mapAuthAccount(requiredRow(result.rows));
  }

  async findAccountByNormalizedUsername(username: string) {
    const result = await this.authQueryable.query<AuthAccountRow>(
      `SELECT ${AUTH_ACCOUNT_FIELDS} FROM accounts WHERE normalized_username = $1`,
      [username],
    );
    return result.rows[0] ? mapAuthAccount(result.rows[0]) : undefined;
  }

  async findAccountById(id: string) {
    const result = await this.authQueryable.query<AuthAccountRow>(
      `SELECT ${AUTH_ACCOUNT_FIELDS} FROM accounts WHERE id = $1 AND password_hash IS NOT NULL`,
      [id],
    );
    return result.rows[0] ? mapAuthAccount(result.rows[0]) : undefined;
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.authQueryable.query(
      'UPDATE accounts SET password_hash = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id, passwordHash],
    );
  }

  async resetCredentials(id: string, passwordHash: string): Promise<void> {
    await this.authQueryable.query(
      `UPDATE accounts SET password_hash = $2,
       credential_version = credential_version + 1,
       updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id, passwordHash],
    );
  }

  async createSession(session: AuthSession): Promise<AuthSession> {
    const result = await this.authQueryable.query<AuthSessionRow>(
      `INSERT INTO sessions
        (id, account_id, token_hash, credential_version, created_at, last_seen_at,
         recent_auth_at, expires_at, idle_expires_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${AUTH_SESSION_FIELDS}`,
      [
        session.id,
        session.accountId,
        session.tokenHash,
        session.credentialVersion,
        session.createdAt,
        session.lastSeenAt,
        session.recentAuthAt,
        session.expiresAt,
        session.idleExpiresAt,
        session.revokedAt,
      ],
    );
    return mapAuthSession(requiredRow(result.rows));
  }

  async findSessionByTokenHash(tokenHash: string) {
    const result = await this.authQueryable.query<AuthSessionRow>(
      `SELECT ${AUTH_SESSION_FIELDS} FROM sessions WHERE token_hash = $1`,
      [tokenHash],
    );
    return result.rows[0] ? mapAuthSession(result.rows[0]) : undefined;
  }

  async touchSession(id: string, lastSeenAt: string, idleExpiresAt: string) {
    const result = await this.authQueryable.query(
      `UPDATE sessions SET last_seen_at = $2, idle_expires_at = $3
       WHERE id = $1 AND revoked_at IS NULL`,
      [id, lastSeenAt, idleExpiresAt],
    );
    return result.rowCount === 1;
  }

  async revokeSession(id: string, revokedAt: string) {
    const result = await this.authQueryable.query(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1`,
      [id, revokedAt],
    );
    return result.rowCount === 1;
  }

  async revokeAllSessions(accountId: string, revokedAt: string) {
    const result = await this.authQueryable.query(
      `UPDATE sessions SET revoked_at = $2
       WHERE account_id = $1 AND revoked_at IS NULL`,
      [accountId, revokedAt],
    );
    return result.rowCount ?? 0;
  }

  async listSessions(accountId: string) {
    const result = await this.authQueryable.query<AuthSessionRow>(
      `SELECT ${AUTH_SESSION_FIELDS} FROM sessions
       WHERE account_id = $1 ORDER BY created_at DESC, id DESC`,
      [accountId],
    );
    return result.rows.map(mapAuthSession);
  }

  async transaction<T>(work: (store: AuthStore) => Promise<T>): Promise<T> {
    if (this.authQueryable !== this.pool) return work(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PostgresAuthStore(this.pool, client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresAuthorizationStore implements AuthorizationStore {
  constructor(
    private readonly pool: Pool,
    private readonly db: Pool | PoolClient = pool,
  ) {}

  async snapshot(
    actorId: string,
    scopes: readonly { type: ScopeType; id: string }[],
  ): Promise<AuthorizationSnapshot> {
    const communityId = scopes.find((scope) => scope.type === 'community')?.id;
    const [account, ownership, roles, assignments, decisions] =
      await Promise.all([
        this.db.query<{
          account_status: 'active' | 'suspended';
          membership_status: Membership['status'] | null;
        }>(
          `SELECT a.status AS account_status, m.status AS membership_status
           FROM accounts a LEFT JOIN memberships m ON m.account_id=a.id AND m.community_id=$2
           WHERE a.id=$1`,
          [actorId, communityId ?? null],
        ),
        communityId
          ? this.db.query<{ id: string }>(
              'SELECT id FROM communities WHERE id = $1 AND owner_id = $2',
              [communityId, actorId],
            )
          : Promise.resolve({ rows: [] }),
        this.db.query<RoleRow>(
          'SELECT id, community_id, name, position, protected, version FROM authorization_roles WHERE community_id IS NULL OR community_id = $1 ORDER BY position, id',
          [communityId ?? null],
        ),
        this.db.query<RoleAssignmentRow>(
          'SELECT role_id, actor_id, community_id, version FROM authorization_role_assignments WHERE actor_id = $1 AND ($2::uuid IS NULL OR community_id = $2)',
          [actorId, communityId ?? null],
        ),
        this.db.query<DecisionRow>(
          'SELECT role_id, permission, scope_type, scope_id, effect FROM authorization_decisions WHERE scope_type = ANY($1::text[]) AND scope_id = ANY($2::uuid[])',
          [scopes.map((scope) => scope.type), scopes.map((scope) => scope.id)],
        ),
      ]);
    return {
      actor: {
        actorId,
        sessionValid: account.rows.length === 1,
        suspended:
          account.rows[0]?.account_status === 'suspended' ||
          (communityId !== undefined &&
            account.rows[0]?.membership_status !== 'active'),
        ownerOf: ownership.rows.map((row) => row.id),
      },
      roles: roles.rows.map(mapRole),
      assignments: assignments.rows.map(mapAssignment),
      decisions: decisions.rows.map(mapDecision),
    };
  }

  async transaction<T>(
    work: (store: AuthorizationStore) => Promise<T>,
  ): Promise<T> {
    if (this.db !== this.pool) return work(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await work(
        new PostgresAuthorizationStore(this.pool, client),
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (isSerializationFailure(error))
        throw new StaleAuthorizationWriteError();
      throw error;
    } finally {
      client.release();
    }
  }

  async putRole(role: Role, expectedVersion?: number): Promise<Role> {
    const result =
      expectedVersion === undefined
        ? await this.db.query<RoleRow>(
            `INSERT INTO authorization_roles (id, community_id, name, position, protected) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, position = EXCLUDED.position, protected = EXCLUDED.protected RETURNING id, community_id, name, position, protected, version`,
            [
              role.id,
              role.communityId,
              role.name,
              role.position,
              role.protected,
            ],
          )
        : await this.db.query<RoleRow>(
            `UPDATE authorization_roles SET name=$3, position=$4, protected=$5, version=version+1 WHERE id=$1 AND version=$2 RETURNING id, community_id, name, position, protected, version`,
            [
              role.id,
              expectedVersion,
              role.name,
              role.position,
              role.protected,
            ],
          );
    if (!result.rows[0]) throw new StaleAuthorizationWriteError();
    return mapRole(result.rows[0]);
  }

  async assignRole(assignment: RoleAssignment): Promise<RoleAssignment> {
    const result = await this.db.query<RoleAssignmentRow>(
      `INSERT INTO authorization_role_assignments (role_id, actor_id, community_id, version) VALUES ($1,$2,$3,1) ON CONFLICT (role_id, actor_id) DO UPDATE SET community_id=EXCLUDED.community_id RETURNING role_id, actor_id, community_id, version`,
      [assignment.roleId, assignment.actorId, assignment.communityId],
    );
    return mapAssignment(requiredRow(result.rows));
  }

  async putDecision(decision: ScopedDecision): Promise<ScopedDecision> {
    const result = await this.db.query<DecisionRow>(
      `INSERT INTO authorization_decisions (role_id, permission, scope_type, scope_id, effect) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (role_id, permission, scope_type, scope_id) DO UPDATE SET effect=EXCLUDED.effect RETURNING role_id, permission, scope_type, scope_id, effect`,
      [
        decision.roleId,
        decision.permission,
        decision.scope.type,
        decision.scope.id,
        decision.effect,
      ],
    );
    return mapDecision(requiredRow(result.rows));
  }

  async transferOwnership(
    communityId: string,
    currentOwnerId: string,
    nextOwnerId: string,
  ): Promise<void> {
    const target = await this.db.query(
      "SELECT 1 FROM memberships WHERE community_id=$1 AND account_id=$2 AND status='active' FOR UPDATE",
      [communityId, nextOwnerId],
    );
    if (target.rowCount !== 1) throw new StaleAuthorizationWriteError();
    const changed = await this.db.query(
      'UPDATE communities SET owner_id=$3, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_id=$2',
      [communityId, currentOwnerId, nextOwnerId],
    );
    if (changed.rowCount !== 1) throw new StaleAuthorizationWriteError();
    await this.db.query(
      'UPDATE community_ownership_versions SET version=version+1 WHERE community_id=$1',
      [communityId],
    );
  }
}

type RoleRow = {
  id: string;
  community_id: string | null;
  name: string;
  position: number;
  protected: boolean;
  version: number;
};
type RoleAssignmentRow = {
  role_id: string;
  actor_id: string;
  community_id: string;
  version: number;
};
type DecisionRow = {
  role_id: string;
  permission: Permission;
  scope_type: ScopeType;
  scope_id: string;
  effect: 'grant' | 'deny';
};
const mapRole = (row: RoleRow): Role => ({
  id: row.id,
  communityId: row.community_id,
  name: row.name,
  position: row.position,
  protected: row.protected,
  version: row.version,
});
const mapAssignment = (row: RoleAssignmentRow): RoleAssignment => ({
  roleId: row.role_id,
  actorId: row.actor_id,
  communityId: row.community_id,
  version: row.version,
});
const mapDecision = (row: DecisionRow): ScopedDecision => ({
  roleId: row.role_id,
  permission: row.permission,
  scope: { type: row.scope_type, id: row.scope_id },
  effect: row.effect,
});
function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '40001'
  );
}

const AUTH_ACCOUNT_FIELDS =
  'id, username, normalized_username, display_name, password_hash, status, credential_version, created_at, updated_at';
const AUTH_SESSION_FIELDS =
  'id, account_id, token_hash, credential_version, created_at, last_seen_at, recent_auth_at, expires_at, idle_expires_at, revoked_at';
type AuthAccountRow = {
  id: string;
  username: string;
  normalized_username: string;
  display_name: string;
  password_hash: string;
  status: 'active' | 'suspended';
  credential_version: number;
  created_at: Date;
  updated_at: Date;
};
type AuthSessionRow = {
  id: string;
  account_id: string;
  token_hash: string;
  credential_version: number;
  created_at: Date;
  last_seen_at: Date;
  recent_auth_at: Date;
  expires_at: Date;
  idle_expires_at: Date;
  revoked_at: Date | null;
};
const mapAuthAccount = (row: AuthAccountRow): AuthAccount => ({
  id: row.id,
  username: row.username,
  normalizedUsername: row.normalized_username,
  displayName: row.display_name,
  passwordHash: row.password_hash,
  status: row.status,
  credentialVersion: row.credential_version,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
const mapAuthSession = (row: AuthSessionRow): AuthSession => ({
  id: row.id,
  accountId: row.account_id,
  tokenHash: row.token_hash,
  credentialVersion: row.credential_version,
  createdAt: row.created_at.toISOString(),
  lastSeenAt: row.last_seen_at.toISOString(),
  recentAuthAt: row.recent_auth_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  idleExpiresAt: row.idle_expires_at.toISOString(),
  revokedAt: row.revoked_at?.toISOString() ?? null,
});

type AccountRow = { id: string; display_name: string };
type CommunityRow = {
  id: string;
  owner_id: string;
  name: string;
  archived_at: Date | null;
  version: number;
};
type MembershipRow = {
  id: string;
  community_id: string;
  account_id: string;
  status: Membership['status'];
  created_at: Date;
  updated_at: Date;
  version: number;
};
type CategoryRow = {
  id: string;
  community_id: string;
  name: string;
  position: number;
  archived_at: Date | null;
  version: number;
};
type SpaceRow = {
  id: string;
  community_id: string;
  category_id: string | null;
  name: string;
  kind: 'text';
  position: number;
  archived_at: Date | null;
  slow_mode_seconds: number;
  version: number;
};
type MessageRow = {
  id: string;
  space_id: string;
  author_id: string;
  body: string | null;
  reply_to_id: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  created_event_id: string;
  created_at: Date;
  updated_at: Date | null;
  deleted_at: Date | null;
  version: number;
};
type SessionRow = {
  id: string;
  account_id: string;
  token_hash: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
};
type InvitationRow = {
  id: string;
  community_id: string;
  creator_id: string;
  token_hash: string;
  target_account_id: string | null;
  created_at: Date;
  expires_at: Date;
  max_uses: number;
  use_count: number;
  revoked_at: Date | null;
  version: number;
};
type AuditEventRow = {
  id: string;
  actor_id: string;
  community_id: string | null;
  invitation_id: string | null;
  action: AuditEvent['action'];
  outcome: AuditEvent['outcome'];
  occurred_at: Date;
};
type ModerationRestrictionRow = {
  id: string;
  community_id: string;
  actor_id: string;
  target_account_id: string;
  kind: 'timeout' | 'ban';
  reason: string;
  request_fingerprint: string;
  idempotency_key: string;
  correlation_id: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  version: number;
};
type ModerationAuditRow = {
  id: string;
  community_id: string;
  actor_id: string;
  target_account_id: string | null;
  target_message_id: string | null;
  action: string;
  outcome: 'succeeded' | 'rejected';
  reason: string | null;
  correlation_id: string;
  occurred_at: Date;
  previous_hash: string | null;
  event_hash: string;
  metadata: Record<string, string | number | boolean | null>;
};
type ModerationMessageEvidenceRow = {
  id: string;
  community_id: string;
  message_id: string;
  body_snapshot: string;
  content_hash: string;
  captured_at: Date;
  retained_until: Date;
  legal_hold: boolean;
};
type ModerationMessageDeletionRow = {
  id: string;
  community_id: string;
  message_id: string;
  actor_id: string;
  target_account_id: string;
  evidence_id: string;
  reason: string;
  request_fingerprint: string;
  idempotency_key: string;
  correlation_id: string;
  event_id: string;
  created_at: Date;
};
type SafetyReportRow = {
  id: string;
  community_id: string;
  reporter_id: string;
  target_account_id: string | null;
  target_message_id: string | null;
  category: SafetyReport['category'];
  description: string;
  evidence_reference_ids: string[];
  status: SafetyReport['status'];
  request_fingerprint: string;
  idempotency_key: string;
  correlation_id: string;
  created_at: Date;
  updated_at: Date;
  version: number;
};
type ModerationCaseRow = {
  id: string;
  community_id: string;
  report_id: string;
  assignee_id: string | null;
  status: ModerationCase['status'];
  idempotency_key: string;
  correlation_id: string;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  version: number;
};
type ModerationCaseActivityRow = {
  id: string;
  case_id: string;
  actor_id: string;
  kind: ModerationCaseActivity['kind'];
  note: string | null;
  linked_action_id: string | null;
  occurred_at: Date;
};
type ModerationAppealRow = {
  id: string;
  community_id: string;
  appellant_id: string;
  restriction_id: string;
  statement: string;
  status: ModerationAppeal['status'];
  reviewer_id: string | null;
  decision_reason: string | null;
  idempotency_key: string;
  correlation_id: string;
  created_at: Date;
  decided_at: Date | null;
  version: number;
};
type ContentLimitsRow = {
  community_id: string;
  message_body_max: number;
  report_description_max: number;
  moderation_reason_max: number;
  updated_by: string;
  updated_at: Date;
  version: number;
};

function accountRepository(db: Queryable): Persistence['accounts'] {
  return {
    async create(account) {
      const result = await db.query<AccountRow>(
        'INSERT INTO accounts (id, display_name) VALUES ($1, $2) RETURNING id, display_name',
        [account.id, account.displayName],
      );
      return mapAccount(requiredRow(result.rows));
    },
    async findById(id) {
      const result = await db.query<AccountRow>(
        'SELECT id, display_name FROM accounts WHERE id = $1',
        [id],
      );
      return result.rows[0] ? mapAccount(result.rows[0]) : undefined;
    },
  };
}

function communityRepository(db: Queryable): Persistence['communities'] {
  const fields = 'id, owner_id, name, archived_at, version';
  return {
    async create(community) {
      const result = await db.query<CommunityRow>(
        `INSERT INTO communities (id, owner_id, name) VALUES ($1, $2, $3) RETURNING ${fields}`,
        [community.id, community.ownerId, community.name],
      );
      return mapCommunity(requiredRow(result.rows));
    },
    async findById(id) {
      const result = await db.query<CommunityRow>(
        `SELECT ${fields} FROM communities WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? mapCommunity(result.rows[0]) : undefined;
    },
    async listVisible(accountId, page) {
      const afterId = decodeCursor(page.cursor);
      const result = await db.query<CommunityRow>(
        `SELECT ${fields} FROM communities c
         WHERE c.archived_at IS NULL AND c.id > $2::uuid
           AND EXISTS (SELECT 1 FROM accounts a WHERE a.id=$1 AND a.status='active')
           AND EXISTS (SELECT 1 FROM memberships m WHERE m.community_id=c.id AND m.account_id=$1 AND m.status='active')
         ORDER BY c.id LIMIT $3`,
        [accountId, afterId, page.limit + 1],
      );
      const items = result.rows.slice(0, page.limit).map(mapCommunity);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          result.rows.length > page.limit && last
            ? encodeCursor(last.id)
            : null,
      };
    },
    async update(id, name, expectedVersion) {
      const result = await db.query<CommunityRow>(
        `UPDATE communities SET name=$2, version=version+1, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND version=$3 AND archived_at IS NULL RETURNING ${fields}`,
        [id, name, expectedVersion],
      );
      return result.rows[0] ? mapCommunity(result.rows[0]) : undefined;
    },
    async archive(id, expectedVersion, archivedAt) {
      const result = await db.query<CommunityRow>(
        `UPDATE communities SET archived_at=$2, version=version+1, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND version=$3 AND archived_at IS NULL RETURNING ${fields}`,
        [id, archivedAt, expectedVersion],
      );
      return result.rows[0] ? mapCommunity(result.rows[0]) : undefined;
    },
  };
}

function membershipRepository(db: Queryable): Persistence['memberships'] {
  return {
    async create(membership) {
      const result = await db.query<MembershipRow>(
        `INSERT INTO memberships
          (id, community_id, account_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, community_id, account_id, status, created_at, updated_at, version`,
        [
          membership.id,
          membership.communityId,
          membership.accountId,
          membership.status,
          membership.createdAt,
          membership.updatedAt,
        ],
      );
      return mapMembership(requiredRow(result.rows));
    },
    async findByCommunityAndAccount(communityId, accountId) {
      const result = await db.query<MembershipRow>(
        `SELECT id, community_id, account_id, status, created_at, updated_at, version
         FROM memberships WHERE community_id = $1 AND account_id = $2`,
        [communityId, accountId],
      );
      return result.rows[0] ? mapMembership(result.rows[0]) : undefined;
    },
    async list(communityId) {
      const result = await db.query<MembershipRow>(
        `SELECT id, community_id, account_id, status, created_at, updated_at, version
         FROM memberships WHERE community_id=$1 ORDER BY created_at, id`,
        [communityId],
      );
      return result.rows.map(mapMembership);
    },
    async updateStatus(id, status, expectedVersion, updatedAt) {
      const result = await db.query<MembershipRow>(
        `UPDATE memberships SET status=$2, updated_at=$3, version=version+1
         WHERE id=$1 AND version=$4 RETURNING id, community_id, account_id, status, created_at, updated_at, version`,
        [id, status, updatedAt, expectedVersion],
      );
      return result.rows[0] ? mapMembership(result.rows[0]) : undefined;
    },
  };
}

function categoryRepository(db: Queryable): Persistence['categories'] {
  const fields = 'id, community_id, name, position, archived_at, version';
  const returning = `RETURNING ${fields}`;
  return {
    async create(category) {
      const result = await db.query<CategoryRow>(
        `INSERT INTO categories (id, community_id, name, position, archived_at)
         VALUES ($1, $2, $3, $4, $5) ${returning}`,
        [
          category.id,
          category.communityId,
          category.name,
          category.position,
          category.archivedAt,
        ],
      );
      return mapCategory(requiredRow(result.rows));
    },
    async findById(id) {
      const result = await db.query<CategoryRow>(
        `SELECT ${fields} FROM categories WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? mapCategory(result.rows[0]) : undefined;
    },
    async list(communityId, includeArchived = false) {
      const result = await db.query<CategoryRow>(
        `SELECT ${fields} FROM categories WHERE community_id=$1 AND ($2 OR archived_at IS NULL) ORDER BY position,id`,
        [communityId, includeArchived],
      );
      return result.rows.map(mapCategory);
    },
    async update(id, input, expectedVersion) {
      const result = await db.query<CategoryRow>(
        `UPDATE categories SET name=$2, position=$3, archived_at=$4, version=version+1, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND version=$5 RETURNING ${fields}`,
        [id, input.name, input.position, input.archivedAt, expectedVersion],
      );
      return result.rows[0] ? mapCategory(result.rows[0]) : undefined;
    },
    async rename(id, name) {
      const result = await db.query<CategoryRow>(
        `UPDATE categories SET name = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 ${returning}`,
        [id, name],
      );
      return result.rows[0] ? mapCategory(result.rows[0]) : undefined;
    },
    async remove(id) {
      const result = await db.query('DELETE FROM categories WHERE id = $1', [
        id,
      ]);
      return result.rowCount === 1;
    },
  };
}

function spaceRepository(db: Queryable): Persistence['spaces'] {
  const fields =
    'id, community_id, category_id, name, kind, position, archived_at, slow_mode_seconds, version';
  const returning = `RETURNING ${fields}`;
  return {
    async create(space) {
      const result = await db.query<SpaceRow>(
        `INSERT INTO spaces
          (id, community_id, category_id, name, kind, position, archived_at, slow_mode_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ${returning}`,
        [
          space.id,
          space.communityId,
          space.categoryId,
          space.name,
          space.kind,
          space.position,
          space.archivedAt,
          space.slowModeSeconds,
        ],
      );
      return mapSpace(requiredRow(result.rows));
    },
    async findById(id) {
      const result = await db.query<SpaceRow>(
        `SELECT ${fields} FROM spaces WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? mapSpace(result.rows[0]) : undefined;
    },
    async list(communityId, page, includeArchived = false) {
      const [afterPosition, afterId] = decodePositionCursor(page.cursor);
      const result = await db.query<SpaceRow>(
        `SELECT ${fields} FROM spaces s WHERE community_id=$1 AND ($2 OR archived_at IS NULL)
         AND ($2 OR category_id IS NULL OR EXISTS (SELECT 1 FROM categories c WHERE c.id=s.category_id AND c.archived_at IS NULL))
         AND (position,id) > ($3,$4::uuid) ORDER BY position,id LIMIT $5`,
        [communityId, includeArchived, afterPosition, afterId, page.limit + 1],
      );
      const items = result.rows.slice(0, page.limit).map(mapSpace);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          result.rows.length > page.limit && last
            ? encodePositionCursor(last.position, last.id)
            : null,
      };
    },
    async update(id, input, expectedVersion) {
      const result = await db.query<SpaceRow>(
        `UPDATE spaces SET name=$2, position=$3, category_id=$4, archived_at=$5, slow_mode_seconds=$6, version=version+1, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND version=$7 RETURNING ${fields}`,
        [
          id,
          input.name,
          input.position,
          input.categoryId,
          input.archivedAt,
          input.slowModeSeconds,
          expectedVersion,
        ],
      );
      return result.rows[0] ? mapSpace(result.rows[0]) : undefined;
    },
    async rename(id, name) {
      const result = await db.query<SpaceRow>(
        `UPDATE spaces SET name = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 ${returning}`,
        [id, name],
      );
      return result.rows[0] ? mapSpace(result.rows[0]) : undefined;
    },
    async remove(id) {
      const result = await db.query('DELETE FROM spaces WHERE id = $1', [id]);
      return result.rowCount === 1;
    },
  };
}

function messageRepository(db: Queryable): Persistence['messages'] {
  const fields =
    'id, space_id, author_id, body, reply_to_id, idempotency_key, request_fingerprint, created_event_id, created_at, updated_at, deleted_at, version';
  return {
    async create(message) {
      const result = await db.query<MessageRow>(
        `INSERT INTO messages
          (id, space_id, author_id, body, reply_to_id, idempotency_key, request_fingerprint, created_event_id, created_at, updated_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (author_id, space_id, idempotency_key) DO UPDATE
           SET idempotency_key = EXCLUDED.idempotency_key
         RETURNING ${fields}`,
        [
          message.id,
          message.spaceId,
          message.authorId,
          message.body,
          message.replyToId,
          message.idempotencyKey,
          message.requestFingerprint,
          message.createdEventId,
          message.createdAt,
          message.updatedAt,
          message.version,
        ],
      );
      return mapMessage(requiredRow(result.rows));
    },
    async findById(id) {
      const result = await db.query<MessageRow>(
        `SELECT ${fields} FROM messages WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? mapMessage(result.rows[0]) : undefined;
    },
    async findByIdempotencyKey(authorId, spaceId, key) {
      const result = await db.query<MessageRow>(
        `SELECT ${fields} FROM messages
         WHERE author_id=$1 AND space_id=$2 AND idempotency_key=$3`,
        [authorId, spaceId, key],
      );
      return result.rows[0] ? mapMessage(result.rows[0]) : undefined;
    },
    async list(spaceId, page) {
      const decoded = page.cursor
        ? Buffer.from(page.cursor, 'base64url').toString()
        : '';
      const separator = decoded.lastIndexOf(':');
      const afterTime = separator < 0 ? 'epoch' : decoded.slice(0, separator);
      const afterId =
        separator < 0
          ? '00000000-0000-0000-0000-000000000000'
          : decoded.slice(separator + 1);
      const result = await db.query<MessageRow>(
        `SELECT ${fields} FROM messages
         WHERE space_id=$1 AND (created_at,id) > ($2::timestamptz,$3::uuid)
         ORDER BY created_at,id LIMIT $4`,
        [spaceId, afterTime, afterId, page.limit + 1],
      );
      const items = result.rows.slice(0, page.limit).map(mapMessage);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          result.rows.length > page.limit && last
            ? Buffer.from(`${last.createdAt}:${last.id}`).toString('base64url')
            : null,
      };
    },
    async update(id, body, expectedVersion, updatedAt) {
      const result = await db.query<MessageRow>(
        `UPDATE messages SET body=$2, updated_at=$3, version=version+1
         WHERE id=$1 AND version=$4 AND deleted_at IS NULL RETURNING ${fields}`,
        [id, body, updatedAt, expectedVersion],
      );
      return result.rows[0] ? mapMessage(result.rows[0]) : undefined;
    },
    async tombstone(id, expectedVersion, deletedAt) {
      const result = await db.query<MessageRow>(
        `UPDATE messages SET body=NULL, deleted_at=COALESCE(deleted_at,$2),
           updated_at=$2, version=version+1
         WHERE id=$1 AND version=$3 AND deleted_at IS NULL RETURNING ${fields}`,
        [id, deletedAt, expectedVersion],
      );
      return result.rows[0] ? mapMessage(result.rows[0]) : undefined;
    },
    async remove(id) {
      const result = await db.query('DELETE FROM messages WHERE id=$1', [id]);
      return result.rowCount === 1;
    },
  };
}

function reactionRepository(db: Queryable): Persistence['reactions'] {
  return {
    async add(reaction) {
      const result = await db.query(
        `INSERT INTO message_reactions (message_id, actor_id, reaction_key, created_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [
          reaction.messageId,
          reaction.actorId,
          reaction.key,
          reaction.createdAt,
        ],
      );
      return result.rowCount === 1;
    },
    async remove(messageId, actorId, key) {
      const result = await db.query(
        'DELETE FROM message_reactions WHERE message_id=$1 AND actor_id=$2 AND reaction_key=$3',
        [messageId, actorId, key],
      );
      return result.rowCount === 1;
    },
    async list(messageId, actorId) {
      const result = await db.query<{
        reaction_key: string;
        reaction_count: string;
        reacted_by_actor: boolean;
      }>(
        `SELECT reaction_key, count(*)::text reaction_count,
           bool_or(actor_id=$2) reacted_by_actor
         FROM message_reactions WHERE message_id=$1
         GROUP BY reaction_key ORDER BY reaction_key`,
        [messageId, actorId],
      );
      return result.rows.map((row) => ({
        key: row.reaction_key,
        count: Number(row.reaction_count),
        reactedByActor: row.reacted_by_actor,
      }));
    },
  };
}

function messagePacingRepository(db: Queryable): Persistence['messagePacing'] {
  return {
    async consume(spaceId, actorId, intervalSeconds) {
      const result = await db.query<{ retry_after: string }>(
        `WITH existing AS (
           SELECT next_allowed_at FROM message_pacing
           WHERE space_id=$1 AND actor_id=$2 FOR UPDATE
         ), admitted AS (
           INSERT INTO message_pacing(space_id, actor_id, next_allowed_at)
           SELECT $1, $2, CURRENT_TIMESTAMP + make_interval(secs => $3)
           WHERE NOT EXISTS (SELECT 1 FROM existing WHERE next_allowed_at > CURRENT_TIMESTAMP)
           ON CONFLICT (space_id, actor_id) DO UPDATE
             SET next_allowed_at=EXCLUDED.next_allowed_at
           WHERE message_pacing.next_allowed_at <= CURRENT_TIMESTAMP
           RETURNING 1
         )
         SELECT CASE WHEN EXISTS (SELECT 1 FROM admitted) THEN 0 ELSE
           GREATEST(1, CEIL(EXTRACT(EPOCH FROM ((SELECT next_allowed_at FROM existing) - CURRENT_TIMESTAMP))))
         END::text retry_after`,
        [spaceId, actorId, intervalSeconds],
      );
      return Number(result.rows[0]?.retry_after ?? 1);
    },
  };
}

function sessionRepository(db: Queryable): Persistence['sessions'] {
  const fields =
    'id, account_id, token_hash, created_at, last_seen_at, expires_at, revoked_at';
  return {
    async create(session) {
      const result = await db.query<SessionRow>(
        `INSERT INTO sessions
          (id, account_id, token_hash, created_at, last_seen_at, expires_at, revoked_at,
           recent_auth_at, idle_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $4, $6) RETURNING ${fields}`,
        [
          session.id,
          session.accountId,
          session.tokenHash,
          session.createdAt,
          session.lastSeenAt,
          session.expiresAt,
          session.revokedAt,
        ],
      );
      return mapSession(requiredRow(result.rows));
    },
    async findByTokenHash(tokenHash) {
      const result = await db.query<SessionRow>(
        `SELECT ${fields} FROM sessions WHERE token_hash = $1`,
        [tokenHash],
      );
      return result.rows[0] ? mapSession(result.rows[0]) : undefined;
    },
    async revoke(id, revokedAt) {
      const result = await db.query(
        'UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
        [id, revokedAt],
      );
      return result.rowCount === 1;
    },
  };
}

function invitationRepository(db: Queryable): Persistence['invitations'] {
  const fields =
    'id, community_id, creator_id, token_hash, target_account_id, created_at, expires_at, max_uses, use_count, revoked_at, version';
  return {
    async create(invitation) {
      const result = await db.query<InvitationRow>(
        `INSERT INTO invitations
          (id, community_id, creator_id, token_hash, target_account_id,
           created_at, expires_at, max_uses, use_count, revoked_at, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${fields}`,
        [
          invitation.id,
          invitation.communityId,
          invitation.creatorId,
          invitation.tokenHash,
          invitation.targetAccountId,
          invitation.createdAt,
          invitation.expiresAt,
          invitation.maxUses,
          invitation.useCount,
          invitation.revokedAt,
          invitation.version,
        ],
      );
      return mapInvitation(requiredRow(result.rows));
    },
    async findById(id) {
      const result = await db.query<InvitationRow>(
        `SELECT ${fields} FROM invitations WHERE id=$1`,
        [id],
      );
      return result.rows[0] ? mapInvitation(result.rows[0]) : undefined;
    },
    async findByTokenHash(tokenHash) {
      const result = await db.query<InvitationRow>(
        `SELECT ${fields} FROM invitations WHERE token_hash=$1`,
        [tokenHash],
      );
      return result.rows[0] ? mapInvitation(result.rows[0]) : undefined;
    },
    async list(communityId) {
      const result = await db.query<InvitationRow>(
        `SELECT ${fields} FROM invitations
         WHERE community_id=$1 ORDER BY created_at DESC,id`,
        [communityId],
      );
      return result.rows.map(mapInvitation);
    },
    async claim(id, expectedVersion, acceptedAt) {
      const result = await db.query<InvitationRow>(
        `UPDATE invitations SET use_count=use_count+1, version=version+1
         WHERE id=$1 AND version=$2 AND revoked_at IS NULL
           AND expires_at>$3 AND use_count<max_uses RETURNING ${fields}`,
        [id, expectedVersion, acceptedAt],
      );
      return result.rows[0] ? mapInvitation(result.rows[0]) : undefined;
    },
    async revoke(id, expectedVersion, revokedAt) {
      const result = await db.query<InvitationRow>(
        `UPDATE invitations SET revoked_at=COALESCE(revoked_at,$3), version=version+1
         WHERE id=$1 AND version=$2 RETURNING ${fields}`,
        [id, expectedVersion, revokedAt],
      );
      return result.rows[0] ? mapInvitation(result.rows[0]) : undefined;
    },
  };
}

function auditEventRepository(db: Queryable): Persistence['auditEvents'] {
  const fields =
    'id, actor_id, community_id, invitation_id, action, outcome, occurred_at';
  return {
    async create(event) {
      const result = await db.query<AuditEventRow>(
        `INSERT INTO audit_events
          (id, actor_id, community_id, invitation_id, action, outcome, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${fields}`,
        [
          event.id,
          event.actorId,
          event.communityId,
          event.invitationId,
          event.action,
          event.outcome,
          event.occurredAt,
        ],
      );
      return mapAuditEvent(requiredRow(result.rows));
    },
    async list(communityId) {
      const result = await db.query<AuditEventRow>(
        `SELECT ${fields} FROM audit_events
         WHERE community_id=$1 ORDER BY occurred_at,id`,
        [communityId],
      );
      return result.rows.map(mapAuditEvent);
    },
  };
}

function moderationRestrictionRepository(
  db: Queryable,
): Persistence['moderationRestrictions'] {
  const fields =
    'id, community_id, actor_id, target_account_id, kind, reason, request_fingerprint, idempotency_key, correlation_id, created_at, expires_at, revoked_at, version';
  return {
    async create(value) {
      const result = await db.query<ModerationRestrictionRow>(
        `INSERT INTO moderation_restrictions
          (id, community_id, actor_id, target_account_id, kind, reason,
           request_fingerprint, idempotency_key, correlation_id, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (actor_id, community_id, idempotency_key) DO UPDATE
           SET idempotency_key=EXCLUDED.idempotency_key
         RETURNING ${fields}`,
        [
          value.id,
          value.communityId,
          value.actorId,
          value.targetAccountId,
          value.kind,
          value.reason,
          value.requestFingerprint,
          value.idempotencyKey,
          value.correlationId,
          value.createdAt,
          value.expiresAt,
        ],
      );
      return mapModerationRestriction(requiredRow(result.rows));
    },
    async findById(id) {
      const result = await db.query<ModerationRestrictionRow>(
        `SELECT ${fields} FROM moderation_restrictions WHERE id=$1`,
        [id],
      );
      return result.rows[0]
        ? mapModerationRestriction(result.rows[0])
        : undefined;
    },
    async findByIdempotencyKey(actorId, communityId, key) {
      const result = await db.query<ModerationRestrictionRow>(
        `SELECT ${fields} FROM moderation_restrictions
         WHERE actor_id=$1 AND community_id=$2 AND idempotency_key=$3`,
        [actorId, communityId, key],
      );
      return result.rows[0]
        ? mapModerationRestriction(result.rows[0])
        : undefined;
    },
    async findEffective(communityId, accountId) {
      const result = await db.query<ModerationRestrictionRow>(
        `SELECT ${fields} FROM moderation_restrictions
         WHERE community_id=$1 AND target_account_id=$2 AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP)
         ORDER BY expires_at DESC NULLS FIRST,id DESC LIMIT 1`,
        [communityId, accountId],
      );
      return result.rows[0]
        ? mapModerationRestriction(result.rows[0])
        : undefined;
    },
    async revoke(id, expectedVersion, revokedAt) {
      const result = await db.query<ModerationRestrictionRow>(
        `UPDATE moderation_restrictions
         SET revoked_at=COALESCE(revoked_at,$3),version=version+1
         WHERE id=$1 AND version=$2 RETURNING ${fields}`,
        [id, expectedVersion, revokedAt],
      );
      return result.rows[0]
        ? mapModerationRestriction(result.rows[0])
        : undefined;
    },
  };
}

function moderationAuditRepository(
  db: Queryable,
): Persistence['moderationAuditEvents'] {
  const fields =
    'id, community_id, actor_id, target_account_id, target_message_id, action, outcome, reason, correlation_id, occurred_at, previous_hash, event_hash, metadata';
  return {
    async create(value) {
      const result = await db.query<ModerationAuditRow>(
        `INSERT INTO moderation_audit_events
          (id, community_id, actor_id, target_account_id, target_message_id,
           action, outcome, reason, correlation_id, occurred_at, previous_hash,
           event_hash, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${fields}`,
        [
          value.id,
          value.communityId,
          value.actorId,
          value.targetAccountId,
          value.targetMessageId,
          value.action,
          value.outcome,
          value.reason,
          value.correlationId,
          value.occurredAt,
          value.previousHash,
          value.eventHash,
          value.metadata,
        ],
      );
      return mapModerationAudit(requiredRow(result.rows));
    },
    async latestHash(communityId) {
      const result = await db.query<{ event_hash: string }>(
        `SELECT event_hash FROM moderation_audit_events
         WHERE community_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 1`,
        [communityId],
      );
      return result.rows[0]?.event_hash;
    },
  };
}

function moderationMessageEvidenceRepository(
  db: Queryable,
): Persistence['moderationMessageEvidence'] {
  return {
    async create(value) {
      const result = await db.query<ModerationMessageEvidenceRow>(
        `INSERT INTO moderation_message_evidence
          (id,community_id,message_id,body_snapshot,content_hash,captured_at,retained_until,legal_hold)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (message_id) DO UPDATE SET message_id=EXCLUDED.message_id
         RETURNING id,community_id,message_id,body_snapshot,content_hash,captured_at,retained_until,legal_hold`,
        [
          value.id,
          value.communityId,
          value.messageId,
          value.bodySnapshot,
          value.contentHash,
          value.capturedAt,
          value.retainedUntil,
          value.legalHold,
        ],
      );
      return mapModerationMessageEvidence(requiredRow(result.rows));
    },
  };
}

function moderationMessageDeletionRepository(
  db: Queryable,
): Persistence['moderationMessageDeletions'] {
  const fields =
    'id,community_id,message_id,actor_id,target_account_id,evidence_id,reason,request_fingerprint,idempotency_key,correlation_id,event_id,created_at';
  return {
    async create(value) {
      const result = await db.query<ModerationMessageDeletionRow>(
        `INSERT INTO moderation_message_deletions
          (id,community_id,message_id,actor_id,target_account_id,evidence_id,reason,
           request_fingerprint,idempotency_key,correlation_id,event_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (actor_id,message_id,idempotency_key) DO UPDATE
           SET idempotency_key=EXCLUDED.idempotency_key RETURNING ${fields}`,
        [
          value.id,
          value.communityId,
          value.messageId,
          value.actorId,
          value.targetAccountId,
          value.evidenceId,
          value.reason,
          value.requestFingerprint,
          value.idempotencyKey,
          value.correlationId,
          value.eventId,
          value.createdAt,
        ],
      );
      return mapModerationMessageDeletion(requiredRow(result.rows));
    },
    async findByIdempotencyKey(actorId, messageId, key) {
      const result = await db.query<ModerationMessageDeletionRow>(
        `SELECT ${fields} FROM moderation_message_deletions
         WHERE actor_id=$1 AND message_id=$2 AND idempotency_key=$3`,
        [actorId, messageId, key],
      );
      return result.rows[0]
        ? mapModerationMessageDeletion(result.rows[0])
        : undefined;
    },
  };
}

function safetyReportRepository(db: Queryable): Persistence['safetyReports'] {
  const fields =
    'id,community_id,reporter_id,target_account_id,target_message_id,category,description,evidence_reference_ids,status,request_fingerprint,idempotency_key,correlation_id,created_at,updated_at,version';
  return {
    async create(value) {
      const result = await db.query<SafetyReportRow>(
        `INSERT INTO safety_reports
          (id,community_id,reporter_id,target_account_id,target_message_id,
           category,description,evidence_reference_ids,status,request_fingerprint,
           idempotency_key,correlation_id,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (reporter_id,community_id,idempotency_key) DO UPDATE
           SET idempotency_key=EXCLUDED.idempotency_key RETURNING ${fields}`,
        [
          value.id,
          value.communityId,
          value.reporterId,
          value.targetAccountId,
          value.targetMessageId,
          value.category,
          value.description,
          value.evidenceReferenceIds,
          value.status,
          value.requestFingerprint,
          value.idempotencyKey,
          value.correlationId,
          value.createdAt,
          value.updatedAt,
          value.version,
        ],
      );
      return mapSafetyReport(requiredRow(result.rows));
    },
    async findById(id) {
      const result = await db.query<SafetyReportRow>(
        `SELECT ${fields} FROM safety_reports WHERE id=$1`,
        [id],
      );
      return result.rows[0] ? mapSafetyReport(result.rows[0]) : undefined;
    },
    async findByIdempotencyKey(reporterId, communityId, key) {
      const result = await db.query<SafetyReportRow>(
        `SELECT ${fields} FROM safety_reports
         WHERE reporter_id=$1 AND community_id=$2 AND idempotency_key=$3`,
        [reporterId, communityId, key],
      );
      return result.rows[0] ? mapSafetyReport(result.rows[0]) : undefined;
    },
  };
}

function moderationCaseRepository(
  db: Queryable,
): Persistence['moderationCases'] {
  const fields =
    'id,community_id,report_id,assignee_id,status,idempotency_key,correlation_id,created_at,updated_at,closed_at,version';
  return {
    async create(value) {
      const result = await db.query<ModerationCaseRow>(
        `INSERT INTO moderation_cases
          (id,community_id,report_id,assignee_id,status,idempotency_key,
           correlation_id,created_at,updated_at,closed_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (report_id) DO UPDATE SET report_id=EXCLUDED.report_id
         RETURNING ${fields}`,
        [
          value.id,
          value.communityId,
          value.reportId,
          value.assigneeId,
          value.status,
          value.idempotencyKey,
          value.correlationId,
          value.createdAt,
          value.updatedAt,
          value.closedAt,
          value.version,
        ],
      );
      return mapModerationCase(requiredRow(result.rows));
    },
    async findById(id) {
      const result = await db.query<ModerationCaseRow>(
        `SELECT ${fields} FROM moderation_cases WHERE id=$1`,
        [id],
      );
      return result.rows[0] ? mapModerationCase(result.rows[0]) : undefined;
    },
    async findByIdempotencyKey(communityId, key) {
      const result = await db.query<ModerationCaseRow>(
        `SELECT ${fields} FROM moderation_cases
         WHERE community_id=$1 AND idempotency_key=$2`,
        [communityId, key],
      );
      return result.rows[0] ? mapModerationCase(result.rows[0]) : undefined;
    },
    async list(communityId, page) {
      const decoded = page.cursor
        ? Buffer.from(page.cursor, 'base64url').toString()
        : '';
      const separator = decoded.lastIndexOf(':');
      const beforeTime =
        separator < 0 ? 'infinity' : decoded.slice(0, separator);
      const beforeId =
        separator < 0
          ? 'ffffffff-ffff-4fff-bfff-ffffffffffff'
          : decoded.slice(separator + 1);
      const result = await db.query<ModerationCaseRow>(
        `SELECT ${fields} FROM moderation_cases
         WHERE community_id=$1 AND (updated_at,id)<($2::timestamptz,$3::uuid)
         ORDER BY updated_at DESC,id DESC LIMIT $4`,
        [communityId, beforeTime, beforeId, page.limit + 1],
      );
      const items = result.rows.slice(0, page.limit).map(mapModerationCase);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          result.rows.length > page.limit && last
            ? Buffer.from(`${last.updatedAt}:${last.id}`).toString('base64url')
            : null,
      };
    },
    async update(id, input, expectedVersion) {
      const result = await db.query<ModerationCaseRow>(
        `UPDATE moderation_cases SET assignee_id=$2,status=$3,updated_at=$4,
           closed_at=$5,version=version+1
         WHERE id=$1 AND version=$6 RETURNING ${fields}`,
        [
          id,
          input.assigneeId,
          input.status,
          input.updatedAt,
          input.closedAt,
          expectedVersion,
        ],
      );
      return result.rows[0] ? mapModerationCase(result.rows[0]) : undefined;
    },
  };
}

function moderationCaseActivityRepository(
  db: Queryable,
): Persistence['moderationCaseActivity'] {
  return {
    async create(value) {
      const result = await db.query<ModerationCaseActivityRow>(
        `INSERT INTO moderation_case_activity
          (id,case_id,actor_id,kind,note,linked_action_id,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id,case_id,actor_id,kind,note,linked_action_id,occurred_at`,
        [
          value.id,
          value.caseId,
          value.actorId,
          value.kind,
          value.note,
          value.linkedActionId,
          value.occurredAt,
        ],
      );
      return mapModerationCaseActivity(requiredRow(result.rows));
    },
    async list(caseId) {
      const result = await db.query<ModerationCaseActivityRow>(
        `SELECT id,case_id,actor_id,kind,note,linked_action_id,occurred_at
         FROM moderation_case_activity WHERE case_id=$1 ORDER BY occurred_at,id`,
        [caseId],
      );
      return result.rows.map(mapModerationCaseActivity);
    },
  };
}

function moderationAppealRepository(
  db: Queryable,
): Persistence['moderationAppeals'] {
  const fields =
    'id,community_id,appellant_id,restriction_id,statement,status,reviewer_id,decision_reason,idempotency_key,correlation_id,created_at,decided_at,version';
  return {
    async create(value) {
      const result = await db.query<ModerationAppealRow>(
        `INSERT INTO moderation_appeals
          (id,community_id,appellant_id,restriction_id,statement,status,
           reviewer_id,decision_reason,idempotency_key,correlation_id,created_at,decided_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (restriction_id) DO UPDATE SET restriction_id=EXCLUDED.restriction_id
         RETURNING ${fields}`,
        [
          value.id,
          value.communityId,
          value.appellantId,
          value.restrictionId,
          value.statement,
          value.status,
          value.reviewerId,
          value.decisionReason,
          value.idempotencyKey,
          value.correlationId,
          value.createdAt,
          value.decidedAt,
          value.version,
        ],
      );
      return mapModerationAppeal(requiredRow(result.rows));
    },
    async findById(id) {
      const result = await db.query<ModerationAppealRow>(
        `SELECT ${fields} FROM moderation_appeals WHERE id=$1`,
        [id],
      );
      return result.rows[0] ? mapModerationAppeal(result.rows[0]) : undefined;
    },
    async findByRestrictionId(restrictionId) {
      const result = await db.query<ModerationAppealRow>(
        `SELECT ${fields} FROM moderation_appeals WHERE restriction_id=$1`,
        [restrictionId],
      );
      return result.rows[0] ? mapModerationAppeal(result.rows[0]) : undefined;
    },
    async findByIdempotencyKey(appellantId, key) {
      const result = await db.query<ModerationAppealRow>(
        `SELECT ${fields} FROM moderation_appeals WHERE appellant_id=$1 AND idempotency_key=$2`,
        [appellantId, key],
      );
      return result.rows[0] ? mapModerationAppeal(result.rows[0]) : undefined;
    },
    async decide(id, status, reviewerId, reason, decidedAt, expectedVersion) {
      const result = await db.query<ModerationAppealRow>(
        `UPDATE moderation_appeals SET status=$2,reviewer_id=$3,decision_reason=$4,
           decided_at=$5,version=version+1
         WHERE id=$1 AND version=$6 AND status='submitted' RETURNING ${fields}`,
        [id, status, reviewerId, reason, decidedAt, expectedVersion],
      );
      return result.rows[0] ? mapModerationAppeal(result.rows[0]) : undefined;
    },
  };
}

function contentLimitsRepository(db: Queryable): Persistence['contentLimits'] {
  const fields =
    'community_id,message_body_max,report_description_max,moderation_reason_max,updated_by,updated_at,version';
  return {
    async find(communityId) {
      const result = await db.query<ContentLimitsRow>(
        `SELECT ${fields} FROM community_content_limits WHERE community_id=$1`,
        [communityId],
      );
      return result.rows[0] ? mapContentLimits(result.rows[0]) : undefined;
    },
    async put(value, expectedVersion) {
      const result =
        expectedVersion === undefined
          ? await db.query<ContentLimitsRow>(
              `INSERT INTO community_content_limits
                (community_id,message_body_max,report_description_max,
                 moderation_reason_max,updated_by,updated_at,version)
               VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING ${fields}`,
              [
                value.communityId,
                value.messageBodyMax,
                value.reportDescriptionMax,
                value.moderationReasonMax,
                value.updatedBy,
                value.updatedAt,
              ],
            )
          : await db.query<ContentLimitsRow>(
              `UPDATE community_content_limits SET message_body_max=$2,
                 report_description_max=$3,moderation_reason_max=$4,updated_by=$5,
                 updated_at=$6,version=version+1
               WHERE community_id=$1 AND version=$7 RETURNING ${fields}`,
              [
                value.communityId,
                value.messageBodyMax,
                value.reportDescriptionMax,
                value.moderationReasonMax,
                value.updatedBy,
                value.updatedAt,
                expectedVersion,
              ],
            );
      return result.rows[0] ? mapContentLimits(result.rows[0]) : undefined;
    },
  };
}

function requiredRow<R>(rows: R[]): R {
  const row = rows[0];
  if (!row) throw new Error('PostgreSQL write returned no row');
  return row;
}

const mapAccount = (row: AccountRow): Account => ({
  id: row.id,
  displayName: row.display_name,
});
const mapCommunity = (row: CommunityRow): Community => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  archivedAt: row.archived_at?.toISOString() ?? null,
  version: row.version,
});
const mapMembership = (row: MembershipRow): Membership => ({
  id: row.id,
  communityId: row.community_id,
  accountId: row.account_id,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  version: row.version,
});
const mapCategory = (row: CategoryRow): Category => ({
  id: row.id,
  communityId: row.community_id,
  name: row.name,
  position: row.position,
  archivedAt: row.archived_at?.toISOString() ?? null,
  version: row.version,
});
const mapSpace = (row: SpaceRow): Space => ({
  id: row.id,
  communityId: row.community_id,
  categoryId: row.category_id,
  name: row.name,
  kind: row.kind,
  position: row.position,
  archivedAt: row.archived_at?.toISOString() ?? null,
  slowModeSeconds: row.slow_mode_seconds,
  version: row.version,
});

const MIN_UUID = '00000000-0000-0000-0000-000000000000';
function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}
function decodeCursor(value?: string): string {
  if (!value) return MIN_UUID;
  try {
    const decoded = Buffer.from(value, 'base64url').toString();
    return /^[0-9a-f-]{36}$/i.test(decoded) ? decoded : MIN_UUID;
  } catch {
    return MIN_UUID;
  }
}
function encodePositionCursor(position: number, id: string): string {
  return Buffer.from(`${String(position)}:${id}`).toString('base64url');
}
function decodePositionCursor(value?: string): [number, string] {
  if (!value) return [-1, MIN_UUID];
  try {
    const [position, id] = Buffer.from(value, 'base64url')
      .toString()
      .split(':');
    return [
      Number(position),
      id && /^[0-9a-f-]{36}$/i.test(id) ? id : MIN_UUID,
    ];
  } catch {
    return [-1, MIN_UUID];
  }
}
const mapMessage = (row: MessageRow): Message => ({
  id: row.id,
  spaceId: row.space_id,
  authorId: row.author_id,
  body: row.body,
  replyToId: row.reply_to_id,
  idempotencyKey: row.idempotency_key,
  requestFingerprint: row.request_fingerprint,
  createdEventId: row.created_event_id,
  createdAt: row.created_at.toISOString(),
  updatedAt: (row.updated_at ?? row.created_at).toISOString(),
  deletedAt: row.deleted_at?.toISOString() ?? null,
  version: row.version,
});
const mapSession = (row: SessionRow): SessionRecord => ({
  id: row.id,
  accountId: row.account_id,
  tokenHash: row.token_hash,
  createdAt: row.created_at.toISOString(),
  lastSeenAt: row.last_seen_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  revokedAt: row.revoked_at?.toISOString() ?? null,
});
const mapInvitation = (row: InvitationRow): Invitation => ({
  id: row.id,
  communityId: row.community_id,
  creatorId: row.creator_id,
  tokenHash: row.token_hash,
  targetAccountId: row.target_account_id,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  maxUses: row.max_uses,
  useCount: row.use_count,
  revokedAt: row.revoked_at?.toISOString() ?? null,
  version: row.version,
});
const mapAuditEvent = (row: AuditEventRow): AuditEvent => ({
  id: row.id,
  actorId: row.actor_id,
  communityId: row.community_id,
  invitationId: row.invitation_id,
  action: row.action,
  outcome: row.outcome,
  occurredAt: row.occurred_at.toISOString(),
});
const mapModerationRestriction = (
  row: ModerationRestrictionRow,
): ModerationRestriction => ({
  id: row.id,
  communityId: row.community_id,
  actorId: row.actor_id,
  targetAccountId: row.target_account_id,
  kind: row.kind,
  reason: row.reason,
  requestFingerprint: row.request_fingerprint,
  idempotencyKey: row.idempotency_key,
  correlationId: row.correlation_id,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at?.toISOString() ?? null,
  revokedAt: row.revoked_at?.toISOString() ?? null,
  version: row.version,
});
const mapModerationAudit = (row: ModerationAuditRow): ModerationAuditEvent => ({
  id: row.id,
  communityId: row.community_id,
  actorId: row.actor_id,
  targetAccountId: row.target_account_id,
  targetMessageId: row.target_message_id,
  action: row.action,
  outcome: row.outcome,
  reason: row.reason,
  correlationId: row.correlation_id,
  occurredAt: row.occurred_at.toISOString(),
  previousHash: row.previous_hash,
  eventHash: row.event_hash,
  metadata: row.metadata,
});
const mapModerationMessageEvidence = (
  row: ModerationMessageEvidenceRow,
): ModerationMessageEvidence => ({
  id: row.id,
  communityId: row.community_id,
  messageId: row.message_id,
  bodySnapshot: row.body_snapshot,
  contentHash: row.content_hash,
  capturedAt: row.captured_at.toISOString(),
  retainedUntil: row.retained_until.toISOString(),
  legalHold: row.legal_hold,
});
const mapModerationMessageDeletion = (
  row: ModerationMessageDeletionRow,
): ModerationMessageDeletion => ({
  id: row.id,
  communityId: row.community_id,
  messageId: row.message_id,
  actorId: row.actor_id,
  targetAccountId: row.target_account_id,
  evidenceId: row.evidence_id,
  reason: row.reason,
  requestFingerprint: row.request_fingerprint,
  idempotencyKey: row.idempotency_key,
  correlationId: row.correlation_id,
  eventId: row.event_id,
  createdAt: row.created_at.toISOString(),
});
const mapSafetyReport = (row: SafetyReportRow): SafetyReport => ({
  id: row.id,
  communityId: row.community_id,
  reporterId: row.reporter_id,
  targetAccountId: row.target_account_id,
  targetMessageId: row.target_message_id,
  category: row.category,
  description: row.description,
  evidenceReferenceIds: row.evidence_reference_ids,
  status: row.status,
  requestFingerprint: row.request_fingerprint,
  idempotencyKey: row.idempotency_key,
  correlationId: row.correlation_id,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  version: row.version,
});
const mapModerationCase = (row: ModerationCaseRow): ModerationCase => ({
  id: row.id,
  communityId: row.community_id,
  reportId: row.report_id,
  assigneeId: row.assignee_id,
  status: row.status,
  idempotencyKey: row.idempotency_key,
  correlationId: row.correlation_id,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  closedAt: row.closed_at?.toISOString() ?? null,
  version: row.version,
});
const mapModerationCaseActivity = (
  row: ModerationCaseActivityRow,
): ModerationCaseActivity => ({
  id: row.id,
  caseId: row.case_id,
  actorId: row.actor_id,
  kind: row.kind,
  note: row.note,
  linkedActionId: row.linked_action_id,
  occurredAt: row.occurred_at.toISOString(),
});
const mapModerationAppeal = (row: ModerationAppealRow): ModerationAppeal => ({
  id: row.id,
  communityId: row.community_id,
  appellantId: row.appellant_id,
  restrictionId: row.restriction_id,
  statement: row.statement,
  status: row.status,
  reviewerId: row.reviewer_id,
  decisionReason: row.decision_reason,
  idempotencyKey: row.idempotency_key,
  correlationId: row.correlation_id,
  createdAt: row.created_at.toISOString(),
  decidedAt: row.decided_at?.toISOString() ?? null,
  version: row.version,
});
const mapContentLimits = (row: ContentLimitsRow): CommunityContentLimits => ({
  communityId: row.community_id,
  messageBodyMax: row.message_body_max,
  reportDescriptionMax: row.report_description_max,
  moderationReasonMax: row.moderation_reason_max,
  updatedBy: row.updated_by,
  updatedAt: row.updated_at.toISOString(),
  version: row.version,
});

interface Migration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

export class MigrationError extends Error {}

export async function readMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const migrations = await Promise.all(
    names.map(async (name) => {
      const sql = await readFile(resolve(directory, name), 'utf8');
      return {
        version: Number(name.slice(0, 4)),
        name,
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      };
    }),
  );
  for (let version = 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
    if (migrations[version - 1]?.version !== version)
      throw new MigrationError(
        `Required migration ${String(version)} is missing`,
      );
  }
  if (migrations.length !== CURRENT_SCHEMA_VERSION)
    throw new MigrationError(
      `Expected ${String(CURRENT_SCHEMA_VERSION)} migrations, found ${String(migrations.length)}`,
    );
  return migrations;
}

export async function migratePostgres(
  pool: Pool,
  directory: string,
  onApplied: (migration: { version: number; name: string }) => void = () => {},
): Promise<number> {
  const migrations = await readMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS nexa_schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL UNIQUE,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const applied = await client.query<{
      version: number;
      name: string;
      checksum: string;
    }>(
      'SELECT version, name, checksum FROM nexa_schema_migrations ORDER BY version',
    );
    for (const existing of applied.rows) {
      const migration = migrations.find(
        (candidate) => candidate.version === existing.version,
      );
      if (
        !migration ||
        migration.name !== existing.name ||
        migration.checksum !== existing.checksum
      )
        throw new MigrationError(
          `Applied migration ${String(existing.version)} is incompatible with this build`,
        );
    }
    for (const migration of migrations.slice(applied.rows.length)) {
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO nexa_schema_migrations (version, name, checksum)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.name, migration.checksum],
      );
      onApplied({ version: migration.version, name: migration.name });
    }
    await client.query('COMMIT');
    return CURRENT_SCHEMA_VERSION;
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original migration failure.
  }
}

export async function currentSchemaVersion(pool: Pool): Promise<number> {
  const result = await pool.query<{ version: number | null }>(
    'SELECT max(version) AS version FROM nexa_schema_migrations',
  );
  return result.rows[0]?.version ?? 0;
}

export async function verifyPostgresSchema(pool: Pool): Promise<number> {
  await pool.query('SELECT 1');
  const version = await currentSchemaVersion(pool);
  if (version !== CURRENT_SCHEMA_VERSION)
    throw new MigrationError(
      `PostgreSQL schema version ${String(version)} is incompatible; expected ${String(CURRENT_SCHEMA_VERSION)}`,
    );
  return version;
}
