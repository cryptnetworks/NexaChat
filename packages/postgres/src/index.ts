import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from 'pg';
import type {
  Account,
  Category,
  Community,
  Membership,
  Message,
  Persistence,
  SessionRecord,
  Space,
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

export const CURRENT_SCHEMA_VERSION = 3;
const MIGRATION_LOCK_ID = 1_318_611_193;
const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../../apps/server/migrations', import.meta.url),
);

export interface PostgresConfig {
  connectionString: string;
  maxConnections: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  queryTimeoutMs: number;
  migrationsDirectory: string;
}

export function postgresConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PostgresConfig {
  const connectionString = environment.DATABASE_URL;
  if (!connectionString)
    throw new Error('DATABASE_URL is required for PostgreSQL storage');
  return {
    connectionString,
    maxConnections: parseBoundedInteger(
      environment.NEXA_DATABASE_POOL_MAX,
      10,
      1,
      50,
      'NEXA_DATABASE_POOL_MAX',
    ),
    connectionTimeoutMs: parseBoundedInteger(
      environment.NEXA_DATABASE_CONNECT_TIMEOUT_MS,
      5_000,
      100,
      60_000,
      'NEXA_DATABASE_CONNECT_TIMEOUT_MS',
    ),
    idleTimeoutMs: parseBoundedInteger(
      environment.NEXA_DATABASE_IDLE_TIMEOUT_MS,
      30_000,
      1_000,
      300_000,
      'NEXA_DATABASE_IDLE_TIMEOUT_MS',
    ),
    queryTimeoutMs: parseBoundedInteger(
      environment.NEXA_DATABASE_QUERY_TIMEOUT_MS,
      5_000,
      100,
      60_000,
      'NEXA_DATABASE_QUERY_TIMEOUT_MS',
    ),
    migrationsDirectory:
      environment.NEXA_MIGRATIONS_DIR ?? resolve(DEFAULT_MIGRATIONS_DIRECTORY),
  };
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(
      `${name} must be an integer from ${String(minimum)} to ${String(maximum)}`,
    );
  return parsed;
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
  return new Pool(poolConfig);
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
        this.db.query<{ status: 'active' | 'suspended' }>(
          'SELECT status FROM accounts WHERE id = $1',
          [actorId],
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
        suspended: account.rows[0]?.status === 'suspended',
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
      'UPDATE communities SET owner_id=$3, updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_id=$2',
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
type CommunityRow = { id: string; owner_id: string; name: string };
type MembershipRow = {
  id: string;
  community_id: string;
  account_id: string;
  status: Membership['status'];
  created_at: Date;
  updated_at: Date;
};
type CategoryRow = {
  id: string;
  community_id: string;
  name: string;
  position: number;
  archived_at: Date | null;
};
type SpaceRow = {
  id: string;
  community_id: string;
  category_id: string | null;
  name: string;
  kind: 'text';
  position: number;
  archived_at: Date | null;
};
type MessageRow = {
  id: string;
  space_id: string;
  author_id: string;
  body: string;
  created_at: Date;
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
  return {
    async create(community) {
      const result = await db.query<CommunityRow>(
        'INSERT INTO communities (id, owner_id, name) VALUES ($1, $2, $3) RETURNING id, owner_id, name',
        [community.id, community.ownerId, community.name],
      );
      return mapCommunity(requiredRow(result.rows));
    },
    async findById(id) {
      const result = await db.query<CommunityRow>(
        'SELECT id, owner_id, name FROM communities WHERE id = $1',
        [id],
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
         RETURNING id, community_id, account_id, status, created_at, updated_at`,
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
        `SELECT id, community_id, account_id, status, created_at, updated_at
         FROM memberships WHERE community_id = $1 AND account_id = $2`,
        [communityId, accountId],
      );
      return result.rows[0] ? mapMembership(result.rows[0]) : undefined;
    },
  };
}

function categoryRepository(db: Queryable): Persistence['categories'] {
  const returning = 'RETURNING id, community_id, name, position, archived_at';
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
        'SELECT id, community_id, name, position, archived_at FROM categories WHERE id = $1',
        [id],
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
  const returning =
    'RETURNING id, community_id, category_id, name, kind, position, archived_at';
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
        'SELECT id, community_id, category_id, name, kind, position, archived_at FROM spaces WHERE id = $1',
        [id],
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
  return {
    async create(message) {
      const result = await db.query<MessageRow>(
        `INSERT INTO messages (id, space_id, author_id, body, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, space_id, author_id, body, created_at`,
        [
          message.id,
          message.spaceId,
          message.authorId,
          message.body,
          message.createdAt,
        ],
      );
      return mapMessage(requiredRow(result.rows));
    },
    async findById(id) {
      const result = await db.query<MessageRow>(
        'SELECT id, space_id, author_id, body, created_at FROM messages WHERE id = $1',
        [id],
      );
      return result.rows[0] ? mapMessage(result.rows[0]) : undefined;
    },
    async remove(id) {
      const result = await db.query('DELETE FROM messages WHERE id = $1', [id]);
      return result.rowCount === 1;
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
});
const mapMembership = (row: MembershipRow): Membership => ({
  id: row.id,
  communityId: row.community_id,
  accountId: row.account_id,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
const mapCategory = (row: CategoryRow): Category => ({
  id: row.id,
  communityId: row.community_id,
  name: row.name,
  position: row.position,
  archivedAt: row.archived_at?.toISOString() ?? null,
});
const mapSpace = (row: SpaceRow): Space => ({
  id: row.id,
  communityId: row.community_id,
  categoryId: row.category_id,
  name: row.name,
  kind: row.kind,
  position: row.position,
  archivedAt: row.archived_at?.toISOString() ?? null,
});
const mapMessage = (row: MessageRow): Message => ({
  id: row.id,
  spaceId: row.space_id,
  authorId: row.author_id,
  body: row.body,
  createdAt: row.created_at.toISOString(),
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
