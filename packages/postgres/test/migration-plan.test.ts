import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  MigrationError,
  buildPostgresUpgradePlan,
  readMigrations,
  type AppliedMigrationRecord,
} from '../src/index.js';

const migrationsDirectory = resolve('apps/server/migrations');

describe('PostgreSQL upgrade planning', () => {
  it('plans a clean database through every contiguous migration', async () => {
    const migrations = await readMigrations(migrationsDirectory);
    const plan = buildPostgresUpgradePlan(migrations, []);
    expect(plan.fromSchema).toBe(0);
    expect(plan.toSchema).toBe(CURRENT_SCHEMA_VERSION);
    expect(plan.pendingVersions).toEqual(
      Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1),
    );
    expect(plan.migrationSetSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('plans only unapplied migrations from a verified historical schema', async () => {
    const migrations = await readMigrations(migrationsDirectory);
    const applied: AppliedMigrationRecord[] = migrations
      .slice(0, 2)
      .map(({ version, name, checksum }) => ({ version, name, checksum }));
    const plan = buildPostgresUpgradePlan(migrations, applied);
    expect(plan.fromSchema).toBe(2);
    expect(plan.pendingVersions[0]).toBe(3);
    expect(plan.pendingVersions.at(-1)).toBe(CURRENT_SCHEMA_VERSION);
    expect(plan.pendingVersions).toHaveLength(CURRENT_SCHEMA_VERSION - 2);
  });

  it.each<AppliedMigrationRecord>([
    {
      version: 2,
      name: '0002_secure_local_auth.sql',
      checksum: 'a'.repeat(64),
    },
    { version: 1, name: 'renamed.sql', checksum: 'a'.repeat(64) },
    {
      version: 1,
      name: '0001_initial_schema.sql',
      checksum: '0'.repeat(64),
    },
    {
      version: CURRENT_SCHEMA_VERSION + 1,
      name: 'ahead.sql',
      checksum: 'a'.repeat(64),
    },
  ])(
    'rejects gaps, renames, checksum drift, and ahead history',
    async (record) => {
      const migrations = await readMigrations(migrationsDirectory);
      expect(() => buildPostgresUpgradePlan(migrations, [record])).toThrow(
        MigrationError,
      );
    },
  );

  it('produces the same migration-set identity from repeated reads', async () => {
    const first = buildPostgresUpgradePlan(
      await readMigrations(migrationsDirectory),
      [],
    );
    const second = buildPostgresUpgradePlan(
      await readMigrations(migrationsDirectory),
      [],
    );
    expect(second.migrationSetSha256).toBe(first.migrationSetSha256);
  });
});
