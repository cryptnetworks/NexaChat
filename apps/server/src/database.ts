import { CommunityService } from '@nexa/domain';
import {
  PostgresPersistence,
  PostgresAuthorizationStore,
  PostgresNotificationAuthorization,
  PostgresNotificationStore,
  PostgresNotificationPreferenceAuthorization,
  PostgresNotificationPreferenceStore,
  PostgresNotificationReadAuthorization,
  PostgresNotificationReadStore,
  PostgresPresenceVisibility,
  PostgresMemberStatusStore,
  createPostgresPool,
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
import {
  NotificationPreferenceService,
  NotificationReadService,
  NotificationService,
  PresenceService,
  MemberStatusService,
} from '@nexa/domain';
import { WebPushRuntime, type WebPushRuntimeConfig } from './web-push.js';
import type { EphemeralCoordination } from '@nexa/coordination';
import { CoordinatedPresence, MEMBER_STATUS_CHANNEL } from './presence.js';
import { MentionRuntime } from './mentions.js';

export async function initializeDatabase(
  config: PostgresConfig,
  authentication?: RuntimeConfig['authentication'],
  telemetry?: Telemetry,
  webPushConfig?: WebPushRuntimeConfig,
  coordination?: EphemeralCoordination,
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
  const authorization = new AuthorizationService(
    new PostgresAuthorizationStore(pool),
    {
      decision(permission, decision) {
        telemetry?.authorizationDecision(decision, permission);
      },
    },
  );
  const persistence = new PostgresPersistence(pool, pool, authorization);
  const notificationAuthorization = new PostgresNotificationAuthorization(pool);
  const notifications = new NotificationService(
    new PostgresNotificationStore(pool),
    notificationAuthorization,
  );
  const notificationPreferences = new NotificationPreferenceService(
    new PostgresNotificationPreferenceStore(pool),
    new PostgresNotificationPreferenceAuthorization(pool),
  );
  const notificationReadState = new NotificationReadService(
    new PostgresNotificationReadStore(pool),
    new PostgresNotificationReadAuthorization(pool),
  );
  const webPush = webPushConfig
    ? new WebPushRuntime(
        pool,
        webPushConfig,
        notificationAuthorization,
        notificationPreferences,
      )
    : undefined;
  if (webPush)
    notifications.setPublisher({
      publish: (notification) =>
        webPush.deliver(notification).then(() => undefined),
    });
  const memberVisibility = new PostgresPresenceVisibility(pool);
  const presence = coordination
    ? new PresenceService(
        new CoordinatedPresence(coordination),
        memberVisibility,
      )
    : undefined;
  const memberStatus = new MemberStatusService(
    new PostgresMemberStatusStore(pool),
    memberVisibility,
  );
  if (coordination)
    memberStatus.setPublisher({
      publish: (status) =>
        coordination.publish(
          MEMBER_STATUS_CHANNEL,
          JSON.stringify({
            accountId: status.accountId,
            updatedAt: status.updatedAt,
            version: status.version,
          }),
        ),
    });
  const mentions = new MentionRuntime(pool, authorization, notifications);
  const readiness = postgresReadiness(pool, telemetry, expectedMigrations);
  return {
    pool,
    service: new CommunityService(persistence, authorization),
    authorization,
    readiness,
    experience: {
      notifications,
      notificationPreferences,
      notificationReadState,
      ...(webPush ? { webPush } : {}),
      ...(presence ? { presence } : {}),
      memberStatus,
      mentions,
    },
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
