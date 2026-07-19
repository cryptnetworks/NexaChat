import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommunityService, type AuditEventInput } from '@nexa/domain';
import {
  CURRENT_SCHEMA_VERSION,
  MigrationError,
  PostgresAuthorizationStore,
  PostgresPersistence,
  createPostgresPool,
  migratePostgres,
  readMigrations,
  verifyPostgresSchema,
  type PostgresConfig,
} from '../src/index.js';

const adminUrl =
  process.env.DATABASE_TEST_URL ??
  'postgresql://nexa:local-development-password@127.0.0.1:5432/nexa';
const databaseName = `nexa_test_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const migrationsDirectory = resolve('apps/server/migrations');
const config: PostgresConfig = {
  connectionString: databaseUrl.toString(),
  maxConnections: 8,
  connectionTimeoutMs: 2_000,
  idleTimeoutMs: 2_000,
  queryTimeoutMs: 2_000,
  migrationsDirectory,
};
let pool: Pool;
let poolInitialized = false;
let databaseCreated = false;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function withAdminPool(
  operation: (admin: Pool) => Promise<void>,
): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl });
  let operationError: Error | undefined;
  try {
    await operation(admin);
  } catch (error) {
    operationError = asError(error);
  }
  let cleanupError: Error | undefined;
  try {
    await admin.end();
  } catch (error) {
    cleanupError = asError(error);
  }
  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      'PostgreSQL admin operation and cleanup both failed',
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
}

beforeAll(async () => {
  await withAdminPool(async (admin) => {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
  });
  pool = createPostgresPool(config);
  poolInitialized = true;
  await migratePostgres(pool, migrationsDirectory);
});

afterAll(async () => {
  const cleanupErrors: Error[] = [];
  if (poolInitialized) {
    try {
      await pool.end();
    } catch (error) {
      cleanupErrors.push(asError(error));
    }
  }
  if (databaseCreated) {
    try {
      await withAdminPool(async (admin) => {
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      });
    } catch (error) {
      cleanupErrors.push(asError(error));
    }
  }
  const [firstCleanupError] = cleanupErrors;
  if (cleanupErrors.length === 1 && firstCleanupError) {
    throw firstCleanupError;
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'PostgreSQL cleanup failed');
  }
});

describe('PostgreSQL persistence', () => {
  it('stores, retrieves, updates, and deletes every aggregate', async () => {
    const store = new PostgresPersistence(pool);
    const now = new Date('2026-01-02T03:04:05.000Z').toISOString();
    const later = new Date('2026-01-03T03:04:05.000Z').toISOString();
    const account = { id: randomUUID(), displayName: 'Ada' };
    const community = {
      id: randomUUID(),
      ownerId: account.id,
      name: 'Core',
      archivedAt: null,
      version: 1,
    };
    const membership = {
      id: randomUUID(),
      communityId: community.id,
      accountId: account.id,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    const category = {
      id: randomUUID(),
      communityId: community.id,
      name: 'General',
      position: 0,
      archivedAt: null,
      version: 1,
    };
    const space = {
      id: randomUUID(),
      communityId: community.id,
      categoryId: category.id,
      name: 'chat',
      kind: 'text' as const,
      position: 0,
      archivedAt: null,
      version: 1,
    };
    const message = {
      id: randomUUID(),
      spaceId: space.id,
      authorId: account.id,
      body: 'persist me',
      replyToId: null,
      idempotencyKey: 'request-0001',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    };
    const session = {
      id: randomUUID(),
      accountId: account.id,
      tokenHash: 'a'.repeat(64),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: later,
      revokedAt: null,
    };

    await store.accounts.create(account);
    await store.communities.create(community);
    await store.memberships.create(membership);
    await store.categories.create(category);
    await store.spaces.create(space);
    await store.messages.create(message);
    await store.sessions.create(session);

    expect(await store.accounts.findById(account.id)).toEqual(account);
    expect(await store.communities.findById(community.id)).toEqual(community);
    expect(
      await store.memberships.findByCommunityAndAccount(
        community.id,
        account.id,
      ),
    ).toEqual(membership);
    expect((await store.categories.rename(category.id, 'Renamed'))?.name).toBe(
      'Renamed',
    );
    expect((await store.spaces.rename(space.id, 'renamed'))?.name).toBe(
      'renamed',
    );
    expect(await store.messages.findById(message.id)).toEqual(message);
    expect((await store.messages.list(space.id, { limit: 10 })).items).toEqual([
      message,
    ]);
    const edited = await store.messages.update(
      message.id,
      'persisted edit',
      1,
      later,
    );
    expect(edited).toMatchObject({ body: 'persisted edit', version: 2 });
    const tombstone = await store.messages.tombstone(message.id, 2, later);
    expect(tombstone).toMatchObject({
      body: null,
      deletedAt: later,
      version: 3,
    });
    expect(await store.messages.update(message.id, 'stale', 1, later)).toBe(
      undefined,
    );
    expect(await store.sessions.findByTokenHash(session.tokenHash)).toEqual(
      session,
    );
    expect(await store.sessions.revoke(session.id, later)).toBe(true);
    expect(
      (await store.sessions.findByTokenHash(session.tokenHash))?.revokedAt,
    ).toBe(later);
    expect(await store.messages.remove(message.id)).toBe(true);
    expect(await store.messages.remove(message.id)).toBe(false);
    expect(await store.spaces.remove(space.id)).toBe(true);
    expect(await store.categories.remove(category.id)).toBe(true);
  });

  it('returns not found and enforces uniqueness and foreign keys', async () => {
    const store = new PostgresPersistence(pool);
    expect(await store.accounts.findById(randomUUID())).toBeUndefined();
    const account = { id: randomUUID(), displayName: 'Grace' };
    await store.accounts.create(account);
    await expect(store.accounts.create(account)).rejects.toMatchObject({
      code: '23505',
    });
    await expect(
      store.communities.create({
        id: randomUUID(),
        ownerId: randomUUID(),
        name: 'bad',
        archivedAt: null,
        version: 1,
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('commits successful transactions and rolls failed transactions back', async () => {
    const store = new PostgresPersistence(pool);
    const committed = { id: randomUUID(), displayName: 'Committed' };
    await store.transaction((transaction) =>
      transaction.accounts.create(committed),
    );
    expect(await store.accounts.findById(committed.id)).toEqual(committed);
    const rolledBack = { id: randomUUID(), displayName: 'Rolled back' };
    await expect(
      store.transaction(async (transaction) => {
        await transaction.accounts.create(rolledBack);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await store.accounts.findById(rolledBack.id)).toBeUndefined();
  });

  it('persists lifecycle pagination, stale writes, archival, and historical references', async () => {
    const persistence = new PostgresPersistence(pool);
    const service = new CommunityService(persistence);
    const owner = await service.createAccount('Lifecycle owner');
    const community = await service.createCommunity(owner.id, 'Lifecycle');
    const category = await service.createCategory(
      owner.id,
      community.id,
      'General',
    );
    const first = await service.createTextSpace(
      community.id,
      owner.id,
      'first',
      category.id,
    );
    await service.createTextSpace(community.id, owner.id, 'second');
    const pageOne = await service.listSpaces(owner.id, community.id, {
      limit: 1,
    });
    expect(pageOne.items).toHaveLength(1);
    if (!pageOne.nextCursor) throw new Error('expected a second page');
    const pageTwo = await service.listSpaces(owner.id, community.id, {
      limit: 1,
      cursor: pageOne.nextCursor,
    });
    expect(pageTwo.items).toHaveLength(1);
    const message = await service.postMessage(first.id, owner.id, 'History');
    const archived = await service.updateSpace(owner.id, first.id, {
      archived: true,
      expectedVersion: first.version,
    });
    expect(archived.archivedAt).toBeTypeOf('string');
    await expect(
      service.updateSpace(owner.id, first.id, {
        name: 'stale',
        expectedVersion: first.version,
      }),
    ).rejects.toMatchObject({ code: 'stale_write' });
    await expect(persistence.messages.findById(message.id)).resolves.toEqual(
      message,
    );
  });

  it('atomically persists invitation final-use acceptance and audit events', async () => {
    const persistence = new PostgresPersistence(pool);
    const service = new CommunityService(persistence);
    const owner = await service.createAccount('Invite owner');
    const first = await service.createAccount('Invite first');
    const second = await service.createAccount('Invite second');
    const community = await service.createCommunity(owner.id, 'Invitations');
    const created = await service.createInvitation(owner.id, community.id, {
      expiresInSeconds: 600,
      maxUses: 1,
    });
    const results = await Promise.allSettled([
      service.acceptInvitation(first.id, created.token, 'first'),
      service.acceptInvitation(second.id, created.token, 'second'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await persistence.invitations.findById(created.invitation.id),
    ).toMatchObject({ useCount: 1, version: 2 });
    expect(
      (await persistence.auditEvents.list(community.id, { limit: 100 })).items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'invitation.create' }),
        expect.objectContaining({ action: 'invitation.accept' }),
      ]),
    );
  });

  it('serializes audit chains and rejects row mutation at the database boundary', async () => {
    const persistence = new PostgresPersistence(pool);
    const service = new CommunityService(persistence);
    const owner = await service.createAccount('Audit owner');
    const community = await service.createCommunity(owner.id, 'Audit chain');
    const identifiers = Array.from({ length: 25 }, () => randomUUID());
    await Promise.all(
      identifiers.map((id, index) =>
        persistence.auditEvents.create(
          auditInput(id, owner.id, community.id, {
            action: 'invitation.create',
            outcome: index % 2 ? 'rejected' : 'succeeded',
            occurredAt: new Date(1_700_000_000_000 + index).toISOString(),
          }),
        ),
      ),
    );
    await expect(persistence.auditEvents.verify(community.id)).resolves.toEqual(
      expect.objectContaining({ valid: true, count: 25 }),
    );
    const page = await persistence.auditEvents.list(community.id, {
      limit: 100,
    });
    expect(page.items.map((event) => event.sequence)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    const serviceEvent = await persistence.auditEvents.create({
      ...auditInput(randomUUID(), owner.id, community.id, {
        action: 'audit.checkpoint',
        outcome: 'succeeded',
        occurredAt: new Date().toISOString(),
      }),
      actorType: 'service',
      actorId: 'integrity-monitor',
      targetType: 'audit_chain',
      targetId: community.id,
    });
    expect(serviceEvent).toMatchObject({
      actorType: 'service',
      actorId: 'integrity-monitor',
      sequence: 26,
    });
    const checkpoint = await service.checkpointAuditEvents(
      owner.id,
      community.id,
    );
    await expect(persistence.auditEvents.verify(community.id)).resolves.toEqual(
      expect.objectContaining({
        valid: true,
        checkpointSequence: checkpoint.sequence,
        checkpointHash: checkpoint.headHash,
        checkpointValid: true,
      }),
    );
    await service.setAuditLegalHold(
      owner.id,
      community.id,
      true,
      'litigation_hold',
    );
    await expect(
      persistence.auditEvents.retention(
        community.id,
        '2100-01-01T00:00:00.000Z',
      ),
    ).resolves.toEqual({
      policy: 'security_7y',
      legalHold: true,
      eligibleThroughSequence: 0,
    });
    await expect(
      pool.query('UPDATE audit_events SET outcome=$1 WHERE id=$2', [
        'rejected',
        identifiers[0],
      ]),
    ).rejects.toThrow(/append-only/u);
    await expect(
      pool.query('DELETE FROM audit_events WHERE id=$1', [identifiers[0]]),
    ).rejects.toThrow(/append-only/u);
    await expect(
      pool.query('DELETE FROM audit_checkpoints WHERE id=$1', [checkpoint.id]),
    ).rejects.toThrow(/append-only/u);
  });
});

function auditInput(
  id: string,
  actorId: string,
  communityId: string,
  input: Pick<AuditEventInput, 'action' | 'occurredAt' | 'outcome'>,
): AuditEventInput {
  const retention = new Date(input.occurredAt);
  retention.setUTCFullYear(retention.getUTCFullYear() + 7);
  return {
    version: 1,
    id,
    actorType: 'account',
    actorId,
    scopeType: 'community',
    scopeId: communityId,
    targetType: 'none',
    targetId: null,
    reasonCode: null,
    correlationId: randomUUID(),
    retentionUntil: retention.toISOString(),
    ...input,
  };
}

describe('PostgreSQL authorization persistence', () => {
  it('stores roles, assignments and decisions idempotently and protects ownership from stale transfer', async () => {
    const persistence = new PostgresPersistence(pool);
    const authorization = new PostgresAuthorizationStore(pool);
    const owner = { id: randomUUID(), displayName: 'Owner' };
    const next = { id: randomUUID(), displayName: 'Next' };
    await persistence.accounts.create(owner);
    await persistence.accounts.create(next);
    const community = {
      id: randomUUID(),
      ownerId: owner.id,
      name: 'Authorization',
      archivedAt: null,
      version: 1,
    };
    await persistence.communities.create(community);
    const now = new Date().toISOString();
    await persistence.memberships.create({
      id: randomUUID(),
      communityId: community.id,
      accountId: owner.id,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    await persistence.memberships.create({
      id: randomUUID(),
      communityId: community.id,
      accountId: next.id,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    const role = await authorization.putRole({
      id: randomUUID(),
      communityId: community.id,
      name: 'member',
      position: 1,
      protected: false,
      version: 0,
    });
    const assignment = {
      roleId: role.id,
      actorId: next.id,
      communityId: community.id,
      version: 1,
    };
    await authorization.assignRole(assignment);
    await authorization.assignRole(assignment);
    const decision = {
      roleId: role.id,
      permission: 'space.view' as const,
      scope: { type: 'community' as const, id: community.id },
      effect: 'grant' as const,
    };
    await authorization.putDecision(decision);
    await authorization.putDecision(decision);
    const snapshot = await authorization.snapshot(next.id, [decision.scope]);
    expect(snapshot.assignments).toHaveLength(1);
    expect(snapshot.decisions).toEqual([decision]);
    const outcomes = await Promise.allSettled([
      authorization.transaction((store) =>
        store.transferOwnership(community.id, owner.id, next.id),
      ),
      authorization.transaction((store) =>
        store.transferOwnership(community.id, owner.id, next.id),
      ),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
  });
});

describe('PostgreSQL migrations', () => {
  it('migrates an empty database exactly once under concurrent startup', async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const applied: number[] = [];
    await Promise.all([
      migratePostgres(pool, migrationsDirectory, ({ version }) =>
        applied.push(version),
      ),
      migratePostgres(pool, migrationsDirectory, ({ version }) =>
        applied.push(version),
      ),
    ]);
    expect(applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(verifyPostgresSchema(pool)).resolves.toBe(
      CURRENT_SCHEMA_VERSION,
    );
  });

  it('upgrades an existing schema version 2 through the current version', async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const migrations = await readMigrations(migrationsDirectory);
    await pool.query(`CREATE TABLE nexa_schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL UNIQUE,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    for (const migration of migrations.slice(0, 2)) {
      await pool.query(migration.sql);
      await pool.query(
        'INSERT INTO nexa_schema_migrations (version, name, checksum) VALUES ($1,$2,$3)',
        [migration.version, migration.name, migration.checksum],
      );
    }
    const applied: number[] = [];
    await expect(
      migratePostgres(pool, migrationsDirectory, ({ version }) =>
        applied.push(version),
      ),
    ).resolves.toBe(8);
    expect(applied).toEqual([3, 4, 5, 6, 7, 8]);
    await expect(verifyPostgresSchema(pool)).resolves.toBe(8);
  });

  it('backfills and verifies existing version 6 audit rows', async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const migrations = await readMigrations(migrationsDirectory);
    await pool.query(`CREATE TABLE nexa_schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL UNIQUE,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    for (const migration of migrations.slice(0, 6)) {
      await pool.query(migration.sql);
      await pool.query(
        'INSERT INTO nexa_schema_migrations (version, name, checksum) VALUES ($1,$2,$3)',
        [migration.version, migration.name, migration.checksum],
      );
    }
    const actorId = randomUUID();
    const communityId = randomUUID();
    await pool.query('INSERT INTO accounts (id,display_name) VALUES ($1,$2)', [
      actorId,
      'Upgrade actor',
    ]);
    await pool.query(
      'INSERT INTO communities (id,owner_id,name) VALUES ($1,$2,$3)',
      [communityId, actorId, 'Upgrade community'],
    );
    for (let index = 0; index < 2; index += 1)
      await pool.query(
        `INSERT INTO audit_events
          (id,actor_id,community_id,invitation_id,action,outcome,occurred_at)
         VALUES ($1,$2,$3,NULL,'invitation.create','succeeded',$4)`,
        [
          randomUUID(),
          actorId,
          communityId,
          new Date(1_700_000_000_000 + index).toISOString(),
        ],
      );

    await expect(migratePostgres(pool, migrationsDirectory)).resolves.toBe(8);
    const persistence = new PostgresPersistence(pool);
    await expect(persistence.auditEvents.verify(communityId)).resolves.toEqual(
      expect.objectContaining({ valid: true, count: 2 }),
    );
    const page = await persistence.auditEvents.list(communityId, { limit: 10 });
    expect(page.items.map(({ sequence }) => sequence)).toEqual([1, 2]);
  });

  it('rejects missing and incompatible migration history', async () => {
    await expect(
      readMigrations(resolve('packages/postgres/test/empty')),
    ).rejects.toThrow();
    await pool.query(
      "UPDATE nexa_schema_migrations SET checksum = repeat('0', 64) WHERE version = 1",
    );
    await expect(
      migratePostgres(pool, migrationsDirectory),
    ).rejects.toBeInstanceOf(MigrationError);
  });
});
