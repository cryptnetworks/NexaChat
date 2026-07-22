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
  migratePostgres,
  verifyPostgresSchema,
  type PostgresConfig,
} from '@nexa/postgres';
import type { StorageReadiness } from './app.js';
import { createAuthRuntime } from './auth-config.js';
import { AuthorizationService } from '@nexa/authorization';
import type { RuntimeConfig } from './config.js';
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
  webPushConfig?: WebPushRuntimeConfig,
  coordination?: EphemeralCoordination,
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
