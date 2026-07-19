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
  AuditCheckpoint,
  AuditEvent,
  AuditIntegrity,
  Category,
  Community,
  Invitation,
  Membership,
  Message,
  Persistence,
  SessionRecord,
  Space,
} from '@nexa/domain';
import { auditEventHash, zeroAuditHash } from '@nexa/domain';
import type {
  AuthAccount,
  AuthSession,
  AuthStore,
  CredentialSecurityEvent,
} from '@nexa/auth';
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

export const CURRENT_SCHEMA_VERSION = 10;
const MIGRATION_LOCK_ID = 1_318_611_193;

export interface PostgresConfig {
  connectionString: string;
  maxConnections: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  queryTimeoutMs: number;
  migrationsDirectory: string;
}

export interface PostgresPoolObserver {
  event(
    event:
      | 'connect'
      | 'acquire'
      | 'remove'
      | 'query'
      | 'timeout'
      | 'query_error'
      | 'pool_error',
    snapshot: { total: number; idle: number; waiting: number },
    durationMs?: number,
  ): void;
}

export function createPostgresPool(
  config: PostgresConfig,
  observer?: PostgresPoolObserver,
): Pool {
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
  const report = (
    event:
      | 'connect'
      | 'acquire'
      | 'remove'
      | 'query'
      | 'timeout'
      | 'query_error'
      | 'pool_error',
    durationMs?: number,
  ) => {
    try {
      observer?.event(
        event,
        {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        },
        durationMs,
      );
    } catch {
      // Observability cannot change database behavior.
    }
  };
  const observedClients = new WeakSet<PoolClient>();
  const observeClient = (client: PoolClient) => {
    if (observedClients.has(client)) return;
    observedClients.add(client);
    const query = client.query.bind(client) as unknown as (
      ...arguments_: unknown[]
    ) => unknown;
    (
      client as unknown as { query: (...arguments_: unknown[]) => unknown }
    ).query = (...arguments_) => {
      const startedAt = Date.now();
      const callback = arguments_.at(-1);
      if (typeof callback === 'function') {
        const wrappedArguments = [...arguments_];
        wrappedArguments[wrappedArguments.length - 1] = (
          error: unknown,
          value: unknown,
        ) => {
          report(
            error ? queryFailureEvent(error) : 'query',
            Date.now() - startedAt,
          );
          (callback as (error: unknown, value: unknown) => void)(error, value);
        };
        try {
          return query(...wrappedArguments);
        } catch (error) {
          report(queryFailureEvent(error), Date.now() - startedAt);
          throw error;
        }
      }
      let result: unknown;
      try {
        result = query(...arguments_);
      } catch (error) {
        report(queryFailureEvent(error), Date.now() - startedAt);
        throw error;
      }
      if (!isPromise(result)) return result;
      return result.then(
        (value) => {
          report('query', Date.now() - startedAt);
          return value;
        },
        (error: unknown) => {
          report(queryFailureEvent(error), Date.now() - startedAt);
          throw error;
        },
      );
    };
  };
  pool.on('connect', (client) => {
    observeClient(client);
    report('connect');
  });
  pool.on('acquire', (client) => {
    observeClient(client);
    report('acquire');
  });
  pool.on('remove', () => {
    report('remove');
  });
  pool.on('error', () => {
    try {
      console.error(
        JSON.stringify({ event: 'postgres.pool.error', code: 'pool_error' }),
      );
    } catch {
      // Diagnostic sinks cannot make a handled pool error process-fatal.
    }
    report('pool_error');
  });
  return pool;
}

function queryFailureEvent(error: unknown): 'timeout' | 'query_error' {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : undefined;
  return code === '57014' ||
    (error instanceof Error && error.message === 'Query read timeout')
    ? 'timeout'
    : 'query_error';
}

function isPromise(value: unknown): value is Promise<unknown> {
  return value instanceof Promise;
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
  readonly sessions;
  readonly invitations;
  readonly auditEvents;

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
    this.sessions = sessionRepository(queryable);
    this.invitations = invitationRepository(queryable);
    this.auditEvents = auditEventRepository(queryable);
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

  async updateProfile(
    id: string,
    profile: Pick<
      AuthAccount,
      'username' | 'normalizedUsername' | 'displayName' | 'avatar'
    >,
    expectedVersion: number,
  ) {
    const result = await this.authQueryable.query<AuthAccountRow>(
      `UPDATE accounts SET
         username = $2,
         normalized_username = $3,
         display_name = $4,
         avatar_object_key = $5,
         avatar_media_type = $6,
         avatar_byte_length = $7,
         avatar_sha256 = $8,
         profile_version = profile_version + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'active' AND profile_version = $9
       RETURNING ${AUTH_ACCOUNT_FIELDS}`,
      [
        id,
        profile.username,
        profile.normalizedUsername,
        profile.displayName,
        profile.avatar?.objectKey ?? null,
        profile.avatar?.mediaType ?? null,
        profile.avatar?.byteLength ?? null,
        profile.avatar?.sha256 ?? null,
        expectedVersion,
      ],
    );
    return result.rows[0] ? mapAuthAccount(result.rows[0]) : undefined;
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.authQueryable.query(
      'UPDATE accounts SET password_hash = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id, passwordHash],
    );
  }

  async changeCredentials(
    id: string,
    expectedCredentialVersion: number,
    passwordHash: string,
  ) {
    const result = await this.authQueryable.query<AuthAccountRow>(
      `UPDATE accounts SET password_hash = $3,
         credential_version = credential_version + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'active' AND credential_version = $2
       RETURNING ${AUTH_ACCOUNT_FIELDS}`,
      [id, expectedCredentialVersion, passwordHash],
    );
    return result.rows[0] ? mapAuthAccount(result.rows[0]) : undefined;
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
        (id, public_handle, account_id, token_hash, credential_version, created_at,
         last_seen_at, recent_auth_at, expires_at, idle_expires_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING ${AUTH_SESSION_FIELDS}`,
      [
        session.id,
        session.publicHandle,
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

  async revokeOwnedSession(
    accountId: string,
    publicHandle: string,
    revokedAt: string,
  ) {
    const result = await this.authQueryable.query<AuthSessionRow>(
      `UPDATE sessions SET revoked_at = $3
       WHERE account_id = $1 AND public_handle = $2 AND revoked_at IS NULL
       RETURNING ${AUTH_SESSION_FIELDS}`,
      [accountId, publicHandle, revokedAt],
    );
    return result.rows[0] ? mapAuthSession(result.rows[0]) : undefined;
  }

  async revokeAllSessions(accountId: string, revokedAt: string) {
    const result = await this.authQueryable.query(
      `UPDATE sessions SET revoked_at = $2
       WHERE account_id = $1 AND revoked_at IS NULL`,
      [accountId, revokedAt],
    );
    return result.rowCount ?? 0;
  }

  async revokeOtherSessions(
    accountId: string,
    currentSessionId: string,
    revokedAt: string,
  ) {
    const result = await this.authQueryable.query(
      `UPDATE sessions SET revoked_at = $3
       WHERE account_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [accountId, currentSessionId, revokedAt],
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

  async recordSecurityEvent(event: CredentialSecurityEvent): Promise<void> {
    await this.authQueryable.query(
      `INSERT INTO security_notifications
        (id, account_id, notification_type, correlation_id, occurred_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        event.id,
        event.accountId,
        event.notificationType,
        event.correlationId,
        event.occurredAt,
        event.expiresAt,
      ],
    );
    await this.authQueryable.query(
      `INSERT INTO audit_events
        (id, actor_id, community_id, invitation_id, action, outcome, occurred_at,
         event_version, actor_type, scope_type, scope_id, target_type, target_id,
         reason_code, correlation_id, retention_until)
       VALUES ($1,$2,NULL,NULL,$3,'succeeded',$4,1,'account','instance',NULL,
         'account',$2,NULL,$5,$4::timestamptz + interval '7 years')`,
      [
        event.id,
        event.accountId,
        event.action,
        event.occurredAt,
        event.correlationId,
      ],
    );
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
  'id, username, normalized_username, display_name, password_hash, status, credential_version, profile_version, avatar_object_key, avatar_media_type, avatar_byte_length, avatar_sha256, created_at, updated_at';
const AUTH_SESSION_FIELDS =
  'id, public_handle, account_id, token_hash, credential_version, created_at, last_seen_at, recent_auth_at, expires_at, idle_expires_at, revoked_at';
type AuthAccountRow = {
  id: string;
  username: string;
  normalized_username: string;
  display_name: string;
  password_hash: string;
  status: 'active' | 'suspended';
  credential_version: number;
  profile_version: number;
  avatar_object_key: string | null;
  avatar_media_type: 'image/jpeg' | 'image/png' | 'image/webp' | null;
  avatar_byte_length: number | null;
  avatar_sha256: string | null;
  created_at: Date;
  updated_at: Date;
};
type AuthSessionRow = {
  id: string;
  public_handle: string;
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
  profileVersion: row.profile_version,
  avatar:
    row.avatar_object_key &&
    row.avatar_media_type &&
    row.avatar_byte_length !== null &&
    row.avatar_sha256
      ? {
          objectKey: row.avatar_object_key,
          mediaType: row.avatar_media_type,
          byteLength: row.avatar_byte_length,
          sha256: row.avatar_sha256,
        }
      : null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
const mapAuthSession = (row: AuthSessionRow): AuthSession => ({
  id: row.id,
  publicHandle: row.public_handle,
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
  version: number;
};
type MessageRow = {
  id: string;
  space_id: string;
  author_id: string;
  body: string | null;
  reply_to_id: string | null;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date | null;
  deleted_at: Date | null;
  version: number;
};
type SessionRow = {
  id: string;
  account_id: string;
  token_hash: string;
  public_handle: string;
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
  event_version: 1;
  actor_type: AuditEvent['actorType'];
  actor_id: string | null;
  service_id: string | null;
  community_id: string | null;
  scope_type: AuditEvent['scopeType'];
  scope_id: string | null;
  target_type: AuditEvent['targetType'];
  target_id: string | null;
  action: AuditEvent['action'];
  outcome: AuditEvent['outcome'];
  reason_code: string | null;
  correlation_id: string;
  occurred_at: Date;
  retention_until: Date;
  chain_index: string | number;
  previous_hash: string;
  event_hash: string;
};
type AuditCheckpointRow = {
  id: string;
  community_id: string;
  chain_index: string | number;
  head_hash: string;
  actor_type: AuditCheckpoint['actorType'];
  actor_id: string | null;
  service_id: string | null;
  correlation_id: string;
  created_at: Date;
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
    'id, community_id, category_id, name, kind, position, archived_at, version';
  const returning = `RETURNING ${fields}`;
  return {
    async create(space) {
      const result = await db.query<SpaceRow>(
        `INSERT INTO spaces
          (id, community_id, category_id, name, kind, position, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ${returning}`,
        [
          space.id,
          space.communityId,
          space.categoryId,
          space.name,
          space.kind,
          space.position,
          space.archivedAt,
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
        `UPDATE spaces SET name=$2, position=$3, category_id=$4, archived_at=$5, version=version+1, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND version=$6 RETURNING ${fields}`,
        [
          id,
          input.name,
          input.position,
          input.categoryId,
          input.archivedAt,
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
    'id, space_id, author_id, body, reply_to_id, idempotency_key, created_at, updated_at, deleted_at, version';
  return {
    async create(message) {
      const result = await db.query<MessageRow>(
        `INSERT INTO messages
          (id, space_id, author_id, body, reply_to_id, idempotency_key, created_at, updated_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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

function sessionRepository(db: Queryable): Persistence['sessions'] {
  const fields =
    'id, account_id, token_hash, public_handle, created_at, last_seen_at, expires_at, revoked_at';
  return {
    async create(session) {
      const result = await db.query<SessionRow>(
        `INSERT INTO sessions
          (id, account_id, token_hash, public_handle, created_at, last_seen_at, expires_at, revoked_at,
           recent_auth_at, idle_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $5, $7) RETURNING ${fields}`,
        [
          session.id,
          session.accountId,
          session.tokenHash,
          session.publicHandle,
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
    'id, event_version, actor_type, actor_id, service_id, community_id, scope_type, scope_id, target_type, target_id, action, outcome, reason_code, correlation_id, occurred_at, retention_until, chain_index, previous_hash, event_hash';
  const checkpointFields =
    'id, community_id, chain_index, head_hash, actor_type, actor_id, service_id, correlation_id, created_at';
  return {
    async create(event) {
      const result = await db.query<AuditEventRow>(
        `INSERT INTO audit_events
          (id, event_version, actor_type, actor_id, service_id, community_id,
           scope_type, scope_id, target_type, target_id, invitation_id, action,
           outcome, reason_code, correlation_id, occurred_at, retention_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING ${fields}`,
        [
          event.id,
          event.version,
          event.actorType,
          event.actorType === 'account' ? event.actorId : null,
          event.actorType === 'service' ? event.actorId : null,
          event.scopeType === 'community' ? event.scopeId : null,
          event.scopeType,
          event.scopeId,
          event.targetType,
          event.targetId,
          event.targetType === 'invitation' ? event.targetId : null,
          event.action,
          event.outcome,
          event.reasonCode,
          event.correlationId,
          event.occurredAt,
          event.retentionUntil,
        ],
      );
      return mapAuditEvent(requiredRow(result.rows));
    },
    async list(communityId, page) {
      const afterSequence = page.cursor
        ? Number(Buffer.from(page.cursor, 'base64url').toString())
        : 0;
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
        return { items: [], nextCursor: null };
      const result = await db.query<AuditEventRow>(
        `SELECT ${fields} FROM audit_events
         WHERE community_id=$1 AND chain_index>$2
         ORDER BY chain_index LIMIT $3`,
        [communityId, afterSequence, page.limit + 1],
      );
      const hasMore = result.rows.length > page.limit;
      const items = result.rows.slice(0, page.limit).map(mapAuditEvent);
      return {
        items,
        nextCursor: hasMore
          ? Buffer.from(String(items.at(-1)?.sequence ?? 0)).toString(
              'base64url',
            )
          : null,
      };
    },
    async verify(communityId) {
      let previousHash = zeroAuditHash;
      let valid = true;
      let count = 0;
      let afterSequence = 0;
      for (;;) {
        const result = await db.query<AuditEventRow>(
          `SELECT ${fields} FROM audit_events
           WHERE community_id=$1 AND chain_index>$2
           ORDER BY chain_index LIMIT 1000`,
          [communityId, afterSequence],
        );
        const events = result.rows.map(mapAuditEvent);
        for (const event of events) {
          valid &&=
            event.sequence === count + 1 &&
            event.previousHash === previousHash &&
            event.eventHash === auditEventHash(previousHash, event);
          previousHash = event.eventHash;
          afterSequence = event.sequence;
          count += 1;
        }
        if (events.length < 1000) break;
      }
      return {
        valid,
        count,
        headHash: count ? previousHash : null,
        ...(await latestCheckpoint(db, communityId, checkpointFields)),
      };
    },
    async checkpoint(checkpoint) {
      const result = await db.query<AuditCheckpointRow>(
        `INSERT INTO audit_checkpoints
          (id, community_id, chain_index, head_hash, actor_type, actor_id,
           service_id, correlation_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${checkpointFields}`,
        [
          checkpoint.id,
          checkpoint.communityId,
          checkpoint.sequence,
          checkpoint.headHash,
          checkpoint.actorType,
          checkpoint.actorType === 'account' ? checkpoint.actorId : null,
          checkpoint.actorType === 'service' ? checkpoint.actorId : null,
          checkpoint.correlationId,
          checkpoint.createdAt,
        ],
      );
      return mapAuditCheckpoint(requiredRow(result.rows));
    },
    async retention(communityId, now) {
      const result = await db.query<{
        legal_hold: boolean;
        eligible_through_sequence: string | number;
      }>(
        `WITH latest_hold AS (
           SELECT action FROM audit_events
           WHERE community_id=$1 AND action IN
             ('audit.legal_hold.apply','audit.legal_hold.release')
           ORDER BY chain_index DESC LIMIT 1
         )
         SELECT
           COALESCE((SELECT action='audit.legal_hold.apply' FROM latest_hold), false) AS legal_hold,
           CASE WHEN COALESCE((SELECT action='audit.legal_hold.apply' FROM latest_hold), false)
             THEN 0 ELSE COALESCE(MAX(chain_index) FILTER (WHERE retention_until <= $2), 0)
           END AS eligible_through_sequence
         FROM audit_events WHERE community_id=$1`,
        [communityId, now],
      );
      const row = requiredRow(result.rows);
      return {
        policy: 'security_7y',
        legalHold: row.legal_hold,
        eligibleThroughSequence: Number(row.eligible_through_sequence),
      };
    },
  };
}

async function latestCheckpoint(
  db: Queryable,
  communityId: string,
  fields: string,
): Promise<
  Pick<
    AuditIntegrity,
    'checkpointHash' | 'checkpointSequence' | 'checkpointValid'
  >
> {
  const result = await db.query<AuditCheckpointRow>(
    `SELECT ${fields} FROM audit_checkpoints
     WHERE community_id=$1 ORDER BY chain_index DESC LIMIT 1`,
    [communityId],
  );
  const checkpoint = result.rows[0];
  if (!checkpoint)
    return {
      checkpointSequence: null,
      checkpointHash: null,
      checkpointValid: true,
    };
  const match = await db.query<{ valid: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM audit_events
       WHERE community_id=$1 AND chain_index=$2 AND event_hash=$3
     ) AS valid`,
    [communityId, checkpoint.chain_index, checkpoint.head_hash.trim()],
  );
  return {
    checkpointSequence: Number(checkpoint.chain_index),
    checkpointHash: checkpoint.head_hash.trim(),
    checkpointValid: requiredRow(match.rows).valid,
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
  createdAt: row.created_at.toISOString(),
  updatedAt: (row.updated_at ?? row.created_at).toISOString(),
  deletedAt: row.deleted_at?.toISOString() ?? null,
  version: row.version,
});
const mapSession = (row: SessionRow): SessionRecord => ({
  id: row.id,
  accountId: row.account_id,
  tokenHash: row.token_hash,
  publicHandle: row.public_handle,
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
  version: row.event_version,
  id: row.id,
  actorType: row.actor_type,
  actorId:
    row.actor_type === 'account'
      ? (row.actor_id ?? '')
      : (row.service_id ?? ''),
  scopeType: row.scope_type,
  scopeId: row.scope_id,
  targetType: row.target_type,
  targetId: row.target_id,
  action: row.action,
  outcome: row.outcome,
  reasonCode: row.reason_code,
  correlationId: row.correlation_id,
  occurredAt: row.occurred_at.toISOString(),
  retentionUntil: row.retention_until.toISOString(),
  sequence: Number(row.chain_index),
  previousHash: row.previous_hash.trim(),
  eventHash: row.event_hash.trim(),
});

const mapAuditCheckpoint = (row: AuditCheckpointRow): AuditCheckpoint => ({
  id: row.id,
  communityId: row.community_id,
  sequence: Number(row.chain_index),
  headHash: row.head_hash.trim(),
  actorType: row.actor_type,
  actorId:
    row.actor_type === 'account'
      ? (row.actor_id ?? '')
      : (row.service_id ?? ''),
  correlationId: row.correlation_id,
  createdAt: row.created_at.toISOString(),
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

export async function verifyPostgresSchema(
  pool: Pool,
  expected?: readonly Pick<Migration, 'version' | 'name' | 'checksum'>[],
): Promise<number> {
  await pool.query('SELECT 1');
  const version = await currentSchemaVersion(pool);
  if (version !== CURRENT_SCHEMA_VERSION)
    throw new MigrationError(
      `PostgreSQL schema version ${String(version)} is incompatible; expected ${String(CURRENT_SCHEMA_VERSION)}`,
    );
  if (expected) {
    const applied = await pool.query<{
      version: number;
      name: string;
      checksum: string;
    }>(
      'SELECT version, name, checksum FROM nexa_schema_migrations ORDER BY version',
    );
    if (
      applied.rows.length !== expected.length ||
      applied.rows.some((existing, index) => {
        const migration = expected[index];
        return (
          !migration ||
          migration.version !== existing.version ||
          migration.name !== existing.name ||
          migration.checksum !== existing.checksum
        );
      })
    )
      throw new MigrationError(
        'PostgreSQL migration history is incompatible with this build',
      );
  }
  return version;
}
