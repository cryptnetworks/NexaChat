import { CommunityService } from '@nexa/domain';
import {
  PostgresPersistence,
  PostgresAuthorizationStore,
  PostgresNotificationAuthorization,
  PostgresNotificationStore,
  createPostgresPool,
  migratePostgres,
  verifyPostgresSchema,
  type PostgresConfig,
} from '@nexa/postgres';
import type { StorageReadiness } from './app.js';
import { createAuthRuntime } from './auth-config.js';
import { AuthorizationService } from '@nexa/authorization';
import type { RuntimeConfig } from './config.js';
import { NotificationService } from '@nexa/domain';

export async function initializeDatabase(
  config: PostgresConfig,
  authentication?: RuntimeConfig['authentication'],
) {
  const pool = createPostgresPool(config);
  try {
    await migratePostgres(pool, config.migrationsDirectory, (migration) => {
      process.stdout.write(
        `${JSON.stringify({ event: 'migration.applied', ...migration })}\n`,
      );
    });
    await verifyPostgresSchema(pool);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: 'migration.failed', error: safeErrorMessage(error) })}\n`,
    );
    await pool.end();
    throw new Error(`PostgreSQL startup failed: ${safeErrorMessage(error)}`, {
      cause: error,
    });
  }
  const persistence = new PostgresPersistence(pool);
  const authorization = new AuthorizationService(
    new PostgresAuthorizationStore(pool),
  );
  const readiness = postgresReadiness(pool);
  const notifications = new NotificationService(
    new PostgresNotificationStore(pool),
    new PostgresNotificationAuthorization(pool),
  );
  return {
    pool,
    service: new CommunityService(persistence, authorization),
    authorization,
    readiness,
    experience: { notifications },
    ...(authentication
      ? { auth: createAuthRuntime(pool, authentication) }
      : {}),
  };
}

export function postgresReadiness(
  pool: ReturnType<typeof createPostgresPool>,
): StorageReadiness {
  return {
    async check() {
      try {
        const schemaVersion = await verifyPostgresSchema(pool);
        return { ready: true, storage: 'postgresql', schemaVersion };
      } catch {
        return { ready: false, storage: 'postgresql' };
      }
    },
  };
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown database error';
  return error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted]');
}
