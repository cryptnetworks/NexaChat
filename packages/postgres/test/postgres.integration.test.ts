import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  MigrationError,
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

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  pool = createPostgresPool(config);
  await migratePostgres(pool, migrationsDirectory);
});

afterAll(async () => {
  await pool.end();
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

describe('PostgreSQL persistence', () => {
  it('stores, retrieves, updates, and deletes every aggregate', async () => {
    const store = new PostgresPersistence(pool);
    const now = new Date('2026-01-02T03:04:05.000Z').toISOString();
    const later = new Date('2026-01-03T03:04:05.000Z').toISOString();
    const account = { id: randomUUID(), displayName: 'Ada' };
    const community = { id: randomUUID(), ownerId: account.id, name: 'Core' };
    const membership = {
      id: randomUUID(),
      communityId: community.id,
      accountId: account.id,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    };
    const category = {
      id: randomUUID(),
      communityId: community.id,
      name: 'General',
      position: 0,
      archivedAt: null,
    };
    const space = {
      id: randomUUID(),
      communityId: community.id,
      categoryId: category.id,
      name: 'chat',
      kind: 'text' as const,
      position: 0,
      archivedAt: null,
    };
    const message = {
      id: randomUUID(),
      spaceId: space.id,
      authorId: account.id,
      body: 'persist me',
      createdAt: now,
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
    expect(applied).toEqual([1]);
    await expect(verifyPostgresSchema(pool)).resolves.toBe(
      CURRENT_SCHEMA_VERSION,
    );
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
