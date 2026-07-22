import { CommunityService } from '@nexa/domain';
import {
  PostgresPersistence,
  PostgresAuthorizationStore,
  createPostgresPool,
  migratePostgres,
  readMigrations,
  verifyPostgresSchema,
  MigrationError,
  type PostgresConfig,
} from '@nexa/postgres';
import type { StorageReadiness } from './app.js';
import { createAuthRuntime } from './auth-config.js';
import { AuthorizationService } from '@nexa/authorization';
import type { RuntimeConfig } from './config.js';
import type { Telemetry } from './telemetry.js';

export async function initializeDatabase(
  config: PostgresConfig,
  authentication?: RuntimeConfig['authentication'],
  telemetry?: Telemetry,
) {
  const startedAt = Date.now();
  const pool = createPostgresPool(config, {
    event(event, snapshot, durationMs) {
      telemetry?.postgresPool(snapshot.total, snapshot.idle, snapshot.waiting);
      telemetry?.postgres(
        event === 'query' || event === 'query_error'
          ? 'query'
          : event === 'timeout'
            ? 'timeout'
            : event === 'connect'
              ? 'connect'
              : 'pool',
        event === 'query_error' || event === 'pool_error' || event === 'timeout'
          ? 'failure'
          : 'success',
        durationMs,
      );
    },
  });
  let expectedMigrations: Awaited<ReturnType<typeof readMigrations>>;
  try {
    await migratePostgres(pool, config.migrationsDirectory, (migration) => {
      process.stdout.write(
        `${JSON.stringify({ event: 'migration.applied', ...migration })}\n`,
      );
    });
    expectedMigrations = await readMigrations(config.migrationsDirectory);
    await verifyPostgresSchema(pool, expectedMigrations);
    telemetry?.postgres('migration', 'success', Date.now() - startedAt);
  } catch (error) {
    const code = databaseFailureCode(error);
    telemetry?.postgres(
      error instanceof MigrationError
        ? 'migration'
        : error instanceof Error && /timeout/i.test(error.message)
          ? 'timeout'
          : 'query',
      'failure',
      Date.now() - startedAt,
    );
    process.stderr.write(
      `${JSON.stringify({ event: 'migration.failed', code })}\n`,
    );
    await pool.end();
    throw new Error('PostgreSQL startup failed', {
      cause: error,
    });
  }
  const persistence = new PostgresPersistence(pool);
  const authorization = new AuthorizationService(
    new PostgresAuthorizationStore(pool),
    {
      decision(permission, decision) {
        telemetry?.authorizationDecision(decision, permission);
      },
    },
  );
  const readiness = postgresReadiness(pool, telemetry, expectedMigrations);
  return {
    pool,
    service: new CommunityService(persistence, authorization),
    authorization,
    readiness,
    ...(authentication
      ? { auth: createAuthRuntime(pool, authentication) }
      : {}),
  };
}

function databaseFailureCode(
  error: unknown,
): 'schema_incompatible' | 'database_timeout' | 'database_unavailable' {
  if (error instanceof MigrationError) return 'schema_incompatible';
  if (error instanceof Error && /timeout/i.test(error.message))
    return 'database_timeout';
  return 'database_unavailable';
}

export function postgresReadiness(
  pool: ReturnType<typeof createPostgresPool>,
  telemetry?: Telemetry,
  expectedMigrations?: Awaited<ReturnType<typeof readMigrations>>,
): StorageReadiness {
  return {
    async check() {
      const startedAt = Date.now();
      try {
        const schemaVersion = await verifyPostgresSchema(
          pool,
          expectedMigrations,
        );
        telemetry?.postgres('readiness', 'success', Date.now() - startedAt);
        return { ready: true, storage: 'postgresql', schemaVersion };
      } catch {
        telemetry?.postgres('readiness', 'failure', Date.now() - startedAt);
        return { ready: false, storage: 'postgresql' };
      }
    },
  };
}
