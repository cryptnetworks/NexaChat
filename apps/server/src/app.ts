import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  communitySchema,
  communityPageSchema,
  membershipSchema,
  categorySchema,
  spacePageSchema,
  pageQuerySchema,
  actorSchema,
  versionedNameSchema,
  changeMembershipSchema,
  createCategorySchema,
  updateCategorySchema,
  updateSpaceSchema,
  createCommunitySchema,
  createMessageSchema,
  updateMessageSchema,
  deleteMessageSchema,
  messagePageSchema,
  createSpaceSchema,
  messageSchema,
  permissionPreviewRequestSchema,
  permissionPreviewResponseSchema,
  spaceSchema,
  createInvitationSchema,
  invitationActionSchema,
  revokeInvitationSchema,
  invitationSchema,
  createdInvitationSchema,
  invitationPreviewSchema,
  type ErrorResponse,
  reactionMutationSchema,
  reactionAggregateSchema,
  timeoutMemberSchema,
  moderationRestrictionSchema,
  banMemberSchema,
  reverseRestrictionSchema,
  moderatorDeleteMessageSchema,
  createSafetyReportSchema,
  safetyReportReceiptSchema,
  openModerationCaseSchema,
  updateModerationCaseSchema,
  moderationCaseSchema,
  submitAppealSchema,
  decideAppealSchema,
  moderationAppealSchema,
  updateContentLimitsSchema,
  contentLimitsSchema,
  notificationPageQuerySchema,
  notificationPageSchema,
  desktopNotificationPollSchema,
  desktopNotificationDeliveryPageSchema,
  notificationSchema,
  updateNotificationSchema,
  effectiveNotificationPreferenceQuerySchema,
  effectiveNotificationPreferenceSchema,
  notificationPreferenceSchema,
  updateNotificationPreferenceSchema,
  advanceNotificationReadStateSchema,
  notificationReadStateQuerySchema,
  notificationReadStateSchema,
  registerWebPushSubscriptionSchema,
  revokeWebPushSubscriptionSchema,
  webPushConfigurationSchema,
  webPushSubscriptionSchema,
  presenceHeartbeatSchema,
  presenceQuerySchema,
  presenceSchema,
  memberStatusQuerySchema,
  memberStatusSchema,
  updateMemberStatusSchema,
} from '@nexa/api-contracts';
import {
  CommunityService,
  DomainError,
  InMemoryCommunityService,
  type NotificationRecord,
  type NotificationService,
  type NotificationPreferenceService,
  type NotificationReadService,
  type PresenceService,
  type MemberStatusService,
} from '@nexa/domain';
import type { RealtimeEnvelope } from '@nexa/realtime-contracts';
import { AuthenticationError } from '@nexa/auth';
import {
  AuthorizationError,
  type AuthorizationService,
} from '@nexa/authorization';
import {
  HttpSecurityError,
  authenticateRequest,
  authenticateMutation,
  registerAuthRoutes,
  type AuthRuntime,
} from './auth-routes.js';
import type { RuntimeConfig } from './config.js';
import type { WebPushController } from './web-push.js';
import type { MentionRuntime } from './mentions.js';
import { CoordinationError } from '@nexa/coordination';

const desktopNotificationId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const desktopNotificationMaximumId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

function encodeDesktopNotificationCheckpoint(
  updatedAt: string,
  id: string,
): string {
  return Buffer.from(JSON.stringify([updatedAt, id]), 'utf8').toString(
    'base64url',
  );
}

function decodeDesktopNotificationCheckpoint(value: string): {
  updatedAt: string;
  id: string;
} {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== 'string' ||
      typeof decoded[1] !== 'string' ||
      new Date(decoded[0]).toISOString() !== decoded[0] ||
      !desktopNotificationId.test(decoded[1]) ||
      encodeDesktopNotificationCheckpoint(decoded[0], decoded[1]) !== value
    )
      throw new Error('invalid checkpoint');
    return { updatedAt: decoded[0], id: decoded[1].toLowerCase() };
  } catch {
    throw new Error('invalid_desktop_notification_checkpoint');
  }
}

function compareNotificationPosition(
  left: NotificationRecord,
  right: NotificationRecord,
): number {
  return (
    left.updatedAt.localeCompare(right.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function isAfterNotificationPosition(
  value: NotificationRecord,
  updatedAt: string,
  id: string,
): boolean {
  return (
    value.updatedAt > updatedAt ||
    (value.updatedAt === updatedAt && value.id > id)
  );
}

export function buildApp(
  service: CommunityService = new InMemoryCommunityService(),
  readiness: StorageReadiness = memoryReadiness,
  auth?: AuthRuntime,
  authorization?: AuthorizationService,
  serverConfig?: RuntimeConfig['server'],
  experience: ExperienceRuntime = {},
  options: { logging?: boolean } = {},
): FastifyInstance {
  const app = Fastify({
    bodyLimit: serverConfig?.bodyLimitBytes ?? 16_384,
    requestTimeout: serverConfig?.requestTimeoutMs ?? 15_000,
    logger:
      options.logging === false
        ? false
        : {
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body.password',
              'req.body.token',
              'req.body.inviteToken',
              'password',
              'token',
              'cookie',
              'authorization',
            ],
            ...(auth?.logStream ? { stream: auth.logStream } : {}),
          },
    genReqId: () => randomUUID(),
  });
  const requestLimit = serverConfig?.rateLimit ?? 1_000;
  const requestWindowMs = serverConfig?.rateWindowMs ?? 60_000;
  const requestBuckets = new Map<
    string,
    { count: number; startedAt: number }
  >();
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    reply.header('x-api-version', '1');
    const now = Date.now();
    const current = requestBuckets.get(request.ip);
    const bucket =
      !current || now - current.startedAt >= requestWindowMs
        ? { count: 0, startedAt: now }
        : current;
    if (bucket.count >= requestLimit) {
      sendApiError(
        reply,
        429,
        'rate_limited',
        request.id,
        Math.max(
          1,
          Math.ceil((bucket.startedAt + requestWindowMs - now) / 1000),
        ),
      );
      done();
      return;
    }
    requestBuckets.set(request.ip, { ...bucket, count: bucket.count + 1 });
    if (requestBuckets.size > 10_000) {
      const oldest = requestBuckets.keys().next().value;
      if (oldest) requestBuckets.delete(oldest);
    }
    done();
  });

  app.get('/health/live', () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const result = await readiness.check();
    if (!result.ready) {
      reply.header('cache-control', 'no-store');
      reply.header('retry-after', '5');
    }
    return reply.code(result.ready ? 200 : 503).send({
      status: result.ready ? 'ready' : 'unavailable',
      storage: result.storage,
      ...(result.schemaVersion === undefined
        ? {}
        : { schemaVersion: result.schemaVersion }),
    });
  });

  if (auth) registerAuthRoutes(app, auth);

  if (authorization)
    app.post('/v1/permissions/preview', async (request, reply) => {
      const input = permissionPreviewRequestSchema.parse(request.body);
      const actorId = auth
        ? (await authenticateRequest(request, auth)).account.id
        : input.actorId;
      if (actorId !== input.actorId) throw new AuthorizationError('deny');
      return reply.send(
        permissionPreviewResponseSchema.parse(
          await authorization.preview(actorId, input.permission, input.scopes),
        ),
      );
    });

  if (experience.notifications) {
    app.get('/v1/notifications', async (request, reply) => {
      const input = notificationPageQuerySchema.parse(request.query);
      const actorId = await verifiedActor(request, auth, input.actorId);
      return reply.send(
        notificationPageSchema.parse(
          await experience.notifications!.list(actorId, {
            limit: input.limit,
            ...(input.cursor ? { cursor: input.cursor } : {}),
          }),
        ),
      );
    });

    app.patch<{ Params: { notificationId: string } }>(
      '/v1/notifications/:notificationId',
      async (request, reply) => {
        const input = updateNotificationSchema.parse(request.body);
        const actorId = await verifiedActor(request, auth, input.actorId, true);
        return reply.send(
          notificationSchema.parse(
            await experience.notifications!.mark(
              actorId,
              request.params.notificationId,
              input.action,
              input.expectedVersion,
              new Date(),
            ),
          ),
        );
      },
    );
  }

  const desktopNotifications = experience.notifications;
  const desktopNotificationPreferences = experience.notificationPreferences;
  if (desktopNotifications && desktopNotificationPreferences) {
    app.post(
      '/v1/desktop-notification-deliveries/query',
      async (request, reply) => {
        const input = desktopNotificationPollSchema.parse(request.body);
        const actorId = await verifiedActor(request, auth, input.actorId);
        const now = new Date();
        const page = await desktopNotifications.list(actorId, {
          limit: 100,
        });
        const decoded = input.checkpoint
          ? decodeDesktopNotificationCheckpoint(input.checkpoint)
          : null;
        const ordered = [...page.items].sort(compareNotificationPosition);
        const newer = decoded
          ? ordered.filter((item) =>
              isAfterNotificationPosition(item, decoded.updatedAt, decoded.id),
            )
          : ordered;
        const bounded = newer.slice(-20);
        const items = [];
        if (!input.initialize) {
          for (const item of bounded) {
            if (
              item.readAt ||
              item.archivedAt ||
              new Date(item.expiresAt) <= now
            )
              continue;
            const preference = await desktopNotificationPreferences.effective(
              actorId,
              item.scopeId ? { spaceId: item.scopeId } : {},
              item.kind,
              now,
            );
            if (!preference.deliver) continue;
            items.push({
              notificationId: item.id,
              kind: item.kind,
              version: item.version,
              route: '/notifications' as const,
              checkpoint: encodeDesktopNotificationCheckpoint(
                item.updatedAt,
                item.id,
              ),
            });
          }
        }
        const latest = ordered.at(-1);
        const nextCheckpoint = input.initialize
          ? encodeDesktopNotificationCheckpoint(
              now.toISOString(),
              desktopNotificationMaximumId,
            )
          : latest &&
              (!decoded ||
                isAfterNotificationPosition(
                  latest,
                  decoded.updatedAt,
                  decoded.id,
                ))
            ? encodeDesktopNotificationCheckpoint(latest.updatedAt, latest.id)
            : input.checkpoint;
        return reply.header('cache-control', 'no-store').send(
          desktopNotificationDeliveryPageSchema.parse({
            items,
            checkpoint: nextCheckpoint,
            overflow: page.nextCursor !== null || newer.length > 20,
          }),
        );
      },
    );
  }

  if (experience.notificationPreferences) {
    app.get(
      '/v1/notification-preferences/effective',
      async (request, reply) => {
        const input = effectiveNotificationPreferenceQuerySchema.parse(
          request.query,
        );
        const actorId = await verifiedActor(request, auth, input.actorId);
        return reply.send(
          effectiveNotificationPreferenceSchema.parse(
            await experience.notificationPreferences!.effective(
              actorId,
              {
                ...(input.communityId
                  ? { communityId: input.communityId }
                  : {}),
                ...(input.categoryId ? { categoryId: input.categoryId } : {}),
                ...(input.spaceId ? { spaceId: input.spaceId } : {}),
              },
              input.kind,
              new Date(),
            ),
          ),
        );
      },
    );
    app.put('/v1/notification-preferences', async (request, reply) => {
      const input = updateNotificationPreferenceSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      return reply.send(
        notificationPreferenceSchema.parse(
          await experience.notificationPreferences!.update(
            actorId,
            {
              scopeType: input.scopeType,
              scopeId: input.scopeId,
              mode: input.mode,
              mutedUntil: input.mutedUntil,
              ...(input.expectedVersion === undefined
                ? {}
                : { expectedVersion: input.expectedVersion }),
            },
            new Date(),
          ),
        ),
      );
    });
  }

  if (experience.notificationReadState) {
    app.get('/v1/notification-read-state', async (request, reply) => {
      const input = notificationReadStateQuerySchema.parse(request.query);
      const actorId = await verifiedActor(request, auth, input.actorId);
      const state = await experience.notificationReadState!.get(
        actorId,
        input.stream,
      );
      return reply.send(
        state ? notificationReadStateSchema.parse(state) : null,
      );
    });
    app.put('/v1/notification-read-state', async (request, reply) => {
      const input = advanceNotificationReadStateSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      return reply.send(
        notificationReadStateSchema.parse(
          await experience.notificationReadState!.advance({
            accountId: actorId,
            stream: input.stream,
            sequence: input.sequence,
            eventId: input.eventId,
            now: new Date(),
          }),
        ),
      );
    });
  }

  app.get('/v1/web-push/config', (_request, reply) =>
    reply.send(
      webPushConfigurationSchema.parse({
        enabled: Boolean(experience.webPush),
        publicKey: experience.webPush?.config.publicKey ?? null,
      }),
    ),
  );
  if (experience.webPush) {
    app.post('/v1/web-push/subscriptions', async (request, reply) => {
      const input = registerWebPushSubscriptionSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      return reply
        .code(201)
        .send(
          webPushSubscriptionSchema.parse(
            await experience.webPush!.register(actorId, input.subscription),
          ),
        );
    });
    app.delete<{ Params: { subscriptionId: string } }>(
      '/v1/web-push/subscriptions/:subscriptionId',
      async (request, reply) => {
        const input = revokeWebPushSubscriptionSchema.parse(request.body);
        const actorId = await verifiedActor(request, auth, input.actorId, true);
        await experience.webPush!.revoke(
          actorId,
          request.params.subscriptionId,
        );
        return reply.code(204).send();
      },
    );
  }

  if (experience.presence) {
    app.post('/v1/presence/heartbeat', async (request, reply) => {
      const input = presenceHeartbeatSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      const value = await experience.presence!.heartbeat(
        actorId,
        input.available,
        new Date(),
      );
      return reply.send(
        presenceSchema.parse({ accountId: actorId, state: value.state }),
      );
    });
    app.get<{ Params: { accountId: string } }>(
      '/v1/presence/:accountId',
      async (request, reply) => {
        const input = presenceQuerySchema.parse(request.query);
        const actorId = await verifiedActor(request, auth, input.actorId);
        const accountId = presenceSchema.shape.accountId.parse(
          request.params.accountId,
        );
        return reply.send(
          presenceSchema.parse({
            accountId,
            state: await experience.presence!.view(
              actorId,
              accountId,
              new Date(),
            ),
          }),
        );
      },
    );
  }

  if (experience.memberStatus) {
    app.put('/v1/member-status', async (request, reply) => {
      const input = updateMemberStatusSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      return reply.send(
        memberStatusSchema.parse(
          await experience.memberStatus!.update(
            actorId,
            input.text,
            input.expiresAt,
            input.expectedVersion,
            new Date(),
          ),
        ),
      );
    });
    app.get<{ Params: { accountId: string } }>(
      '/v1/member-status/:accountId',
      async (request, reply) => {
        const input = memberStatusQuerySchema.parse(request.query);
        const actorId = await verifiedActor(request, auth, input.actorId);
        const accountId = memberStatusSchema.shape.accountId.parse(
          request.params.accountId,
        );
        const status = await experience.memberStatus!.view(
          actorId,
          accountId,
          new Date(),
        );
        return reply.send(status ? memberStatusSchema.parse(status) : null);
      },
    );
  }

  app.post('/v1/communities', async (request, reply) => {
    const input = createCommunitySchema.parse(request.body);
    if (authorization && auth) {
      const actorId = (await authenticateMutation(request, auth)).account.id;
      if (actorId !== input.ownerId) throw new AuthorizationError('deny');
    }
    return reply
      .code(201)
      .send(
        communitySchema.parse(
          await service.createCommunity(input.ownerId, input.name),
        ),
      );
  });

  app.get('/v1/communities', async (request, reply) => {
    const input = pageQuerySchema.parse(request.query);
    const actorId = await verifiedActor(request, auth, input.actorId);
    return reply.send(
      communityPageSchema.parse(
        await service.listCommunities(actorId, {
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        }),
      ),
    );
  });

  app.get<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId',
    async (request, reply) => {
      const input = actorSchema.parse(request.query);
      const actorId = await verifiedActor(request, auth, input.actorId);
      return reply.send(
        communitySchema.parse(
          await service.getCommunity(actorId, request.params.communityId),
        ),
      );
    },
  );

  app.post('/v1/moderation/appeals', async (request, reply) => {
    const input = submitAppealSchema.parse(request.body);
    const appellantId = await verifiedActor(
      request,
      auth,
      input.appellantId,
      true,
    );
    return reply
      .code(201)
      .send(
        moderationAppealSchema.parse(
          await service.submitModerationAppeal(
            appellantId,
            input.restrictionId,
            input.statement,
            input.idempotencyKey,
            request.id,
          ),
        ),
      );
  });

  app.get<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/content-limits',
    async (request, reply) => {
      const input = actorSchema.parse(request.query);
      const actorId = await verifiedActor(request, auth, input.actorId);
      return reply.send(
        contentLimitsSchema.parse(
          await service.getContentLimits(actorId, request.params.communityId),
        ),
      );
    },
  );

  app.put<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/content-limits',
    async (request, reply) => {
      const input = updateContentLimitsSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      return reply.send(
        contentLimitsSchema.parse(
          await service.updateContentLimits(
            actorId,
            request.params.communityId,
            {
              messageBodyMax: input.messageBodyMax,
              reportDescriptionMax: input.reportDescriptionMax,
              moderationReasonMax: input.moderationReasonMax,
              ...(input.expectedVersion
                ? { expectedVersion: input.expectedVersion }
                : {}),
              correlationId: request.id,
            },
          ),
        ),
      );
    },
  );

  app.post<{ Params: { appealId: string } }>(
    '/v1/moderation/appeals/:appealId/decision',
    async (request, reply) => {
      const input = decideAppealSchema.parse(request.body);
      const reviewerId = await verifiedActor(
        request,
        auth,
        input.reviewerId,
        true,
      );
      return reply.send(
        moderationAppealSchema.parse(
          await service.decideModerationAppeal(
            reviewerId,
            request.params.appealId,
            input.decision,
            input.reason,
            input.expectedVersion,
            request.id,
          ),
        ),
      );
    },
  );

  app.patch<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId',
    async (request, reply) => {
      const input = versionedNameSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      return reply.send(
        communitySchema.parse(
          await service.updateCommunity(
            actorId,
            request.params.communityId,
            input.name,
            input.expectedVersion,
          ),
        ),
      );
    },
  );

  app.delete<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId',
    async (request, reply) => {
      const input = actorSchema
        .extend({ expectedVersion: versionedNameSchema.shape.expectedVersion })
        .strict()
        .parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      return reply.send(
        communitySchema.parse(
          await service.archiveCommunity(
            actorId,
            request.params.communityId,
            input.expectedVersion,
          ),
        ),
      );
    },
  );

  app.get<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/memberships',
    async (request, reply) => {
      const input = actorSchema.parse(request.query);
      const actorId = await verifiedActor(request, auth, input.actorId);
      return reply.send(
        (
          await service.listMemberships(actorId, request.params.communityId)
        ).map((value) => membershipSchema.parse(value)),
      );
    },
  );

  app.put<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/memberships',
    async (request, reply) => {
      const input = changeMembershipSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      return reply.send(
        membershipSchema.parse(
          await service.changeMembership(
            actorId,
            request.params.communityId,
            input.accountId,
            input.status,
            input.expectedVersion,
          ),
        ),
      );
    },
  );

  app.get<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/categories',
    async (request, reply) => {
      const input = actorSchema.parse(request.query);
      const actorId = await verifiedActor(request, auth, input.actorId);
      return reply.send(
        (await service.listCategories(actorId, request.params.communityId)).map(
          (value) => categorySchema.parse(value),
        ),
      );
    },
  );
  app.post<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/categories',
    async (request, reply) => {
      const input = createCategorySchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      return reply
        .code(201)
        .send(
          categorySchema.parse(
            await service.createCategory(
              actorId,
              request.params.communityId,
              input.name,
            ),
          ),
        );
    },
  );
  app.patch<{ Params: { categoryId: string } }>(
    '/v1/categories/:categoryId',
    async (request, reply) => {
      const input = updateCategorySchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      return reply.send(
        categorySchema.parse(
          await service.updateCategory(
            actorId,
            request.params.categoryId,
            input,
          ),
        ),
      );
    },
  );

  app.get<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/spaces',
    async (request, reply) => {
      const input = pageQuerySchema.parse(request.query);
      const actorId = await verifiedActor(request, auth, input.actorId);
      return reply.send(
        spacePageSchema.parse(
          await service.listSpaces(actorId, request.params.communityId, {
            limit: input.limit,
            ...(input.cursor ? { cursor: input.cursor } : {}),
          }),
        ),
      );
    },
  );

  app.post<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/spaces',
    async (request, reply) => {
      const input = createSpaceSchema.parse(request.body);
      if (authorization && auth) {
        const actorId = (await authenticateMutation(request, auth)).account.id;
        if (actorId !== input.actorId) throw new AuthorizationError('deny');
      }
      return reply
        .code(201)
        .send(
          spaceSchema.parse(
            await service.createTextSpace(
              request.params.communityId,
              input.actorId,
              input.name,
              input.categoryId ?? null,
            ),
          ),
        );
    },
  );

  app.patch<{ Params: { spaceId: string } }>(
    '/v1/spaces/:spaceId',
    async (request, reply) => {
      const input = updateSpaceSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      return reply.send(
        spaceSchema.parse(
          await service.updateSpace(actorId, request.params.spaceId, input),
        ),
      );
    },
  );

  app.post<{ Params: { spaceId: string } }>(
    '/v1/spaces/:spaceId/messages',
    async (request, reply) => {
      const input = createMessageSchema.parse(request.body);
      if (authorization && auth) {
        const actorId = (await authenticateMutation(request, auth)).account.id;
        if (actorId !== input.authorId) throw new AuthorizationError('deny');
      }
      const key = input.idempotencyKey ?? request.id;
      const existing = await service.persistence.messages.findByIdempotencyKey(
        input.authorId,
        request.params.spaceId,
        key,
      );
      const message = await service.postMessage(
        request.params.spaceId,
        input.authorId,
        input.body,
        key,
        input.replyToId ?? null,
      );
      await experience.mentions?.process(message);
      const event: RealtimeEnvelope = {
        version: 1,
        id: message.createdEventId,
        type: 'message.created',
        occurredAt: new Date().toISOString(),
        correlationId: request.id,
        payload: { message },
      };
      if (!existing) app.websocketHub?.broadcast(request.params.spaceId, event);
      if (existing) reply.header('idempotent-replayed', 'true');
      return reply
        .code(existing ? 200 : 201)
        .send(messageSchema.parse(message));
    },
  );

  app.get<{ Params: { spaceId: string } }>(
    '/v1/spaces/:spaceId/messages',
    async (request, reply) => {
      const input = pageQuerySchema.parse(request.query);
      const actorId = await verifiedActor(request, auth, input.actorId);
      return reply.send(
        messagePageSchema.parse(
          await service.listMessages(request.params.spaceId, actorId, {
            limit: input.limit,
            ...(input.cursor ? { cursor: input.cursor } : {}),
          }),
        ),
      );
    },
  );

  app.patch<{ Params: { messageId: string } }>(
    '/v1/messages/:messageId',
    async (request, reply) => {
      const input = updateMessageSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      const message = await service.editMessage(
        request.params.messageId,
        actorId,
        input.body,
        input.expectedVersion,
      );
      const event: RealtimeEnvelope = {
        version: 1,
        id: randomUUID(),
        type: 'message.updated',
        occurredAt: new Date().toISOString(),
        correlationId: request.id,
        payload: { message },
      };
      app.websocketHub?.broadcast(message.spaceId, event);
      return reply.send(messageSchema.parse(message));
    },
  );

  app.delete<{ Params: { messageId: string } }>(
    '/v1/messages/:messageId',
    async (request, reply) => {
      const input = deleteMessageSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      const message = await service.deleteMessage(
        request.params.messageId,
        actorId,
        input.expectedVersion,
      );
      const event: RealtimeEnvelope = {
        version: 1,
        id: randomUUID(),
        type: 'message.deleted',
        occurredAt: new Date().toISOString(),
        correlationId: request.id,
        payload: { message },
      };
      app.websocketHub?.broadcast(message.spaceId, event);
      return reply.send(messageSchema.parse(message));
    },
  );

  app.post<{ Params: { messageId: string } }>(
    '/v1/messages/:messageId/moderation-delete',
    async (request, reply) => {
      const input = moderatorDeleteMessageSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      const result = await service.moderatorDeleteMessage(
        actorId,
        request.params.messageId,
        input.reason,
        input.idempotencyKey,
        input.expectedVersion,
        request.id,
      );
      const event: RealtimeEnvelope = {
        version: 1,
        id: result.deletion.eventId,
        type: 'message.deleted',
        occurredAt: result.deletion.createdAt,
        correlationId: request.id,
        payload: { message: result.message },
      };
      app.websocketHub?.broadcast(result.message.spaceId, event);
      return reply.send(messageSchema.parse(result.message));
    },
  );

  app.get<{ Params: { messageId: string } }>(
    '/v1/messages/:messageId/reactions',
    async (request, reply) => {
      const input = actorSchema.parse(request.query);
      const actorId = await verifiedActor(request, auth, input.actorId);
      return reply.send(
        (await service.listReactions(request.params.messageId, actorId)).map(
          (reaction) => reactionAggregateSchema.parse(reaction),
        ),
      );
    },
  );

  for (const method of ['PUT', 'DELETE'] as const)
    app.route<{ Params: { messageId: string; key: string } }>({
      method,
      url: '/v1/messages/:messageId/reactions/:key',
      async handler(request, reply) {
        const input = reactionMutationSchema.parse(request.body);
        const actorId = await verifiedActor(request, auth, input.actorId, true);
        const aggregate = await (method === 'PUT'
          ? service.addReaction(
              request.params.messageId,
              actorId,
              request.params.key,
            )
          : service.removeReaction(
              request.params.messageId,
              actorId,
              request.params.key,
            ));
        return reply.send(
          aggregate.map((reaction) => reactionAggregateSchema.parse(reaction)),
        );
      },
    });

  app.post<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/invitations',
    async (request, reply) => {
      const input = createInvitationSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      const created = await service.createInvitation(
        actorId,
        request.params.communityId,
        {
          expiresInSeconds: input.expiresInSeconds,
          maxUses: input.maxUses,
          targetAccountId: input.targetAccountId ?? null,
        },
      );
      return reply.code(201).send(
        createdInvitationSchema.parse({
          invitation: publicInvitation(created.invitation),
          token: created.token,
        }),
      );
    },
  );

  app.post<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/timeouts',
    async (request, reply) => {
      const input = timeoutMemberSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      const timeout = await service.timeoutMember(
        actorId,
        request.params.communityId,
        input.targetAccountId,
        input.durationSeconds,
        input.reason,
        input.idempotencyKey,
        request.id,
      );
      return reply.code(201).send(moderationRestrictionSchema.parse(timeout));
    },
  );

  app.post<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/bans',
    async (request, reply) => {
      const input = banMemberSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      const ban = await service.banMember(
        actorId,
        request.params.communityId,
        input.targetAccountId,
        input.durationSeconds ?? null,
        input.reason,
        input.idempotencyKey,
        request.id,
      );
      return reply.code(201).send(moderationRestrictionSchema.parse(ban));
    },
  );

  app.post<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/reports',
    async (request, reply) => {
      const input = createSafetyReportSchema.parse(request.body);
      const reporterId = await verifiedActor(
        request,
        auth,
        input.reporterId,
        true,
      );
      const report = await service.createSafetyReport(
        reporterId,
        request.params.communityId,
        {
          ...(input.targetAccountId
            ? { targetAccountId: input.targetAccountId }
            : {}),
          ...(input.targetMessageId
            ? { targetMessageId: input.targetMessageId }
            : {}),
          category: input.category,
          description: input.description,
          evidenceReferenceIds: input.evidenceReferenceIds,
          idempotencyKey: input.idempotencyKey,
          correlationId: request.id,
        },
      );
      return reply.code(202).send(safetyReportReceiptSchema.parse(report));
    },
  );

  app.get<{ Params: { reportId: string } }>(
    '/v1/reports/:reportId',
    async (request, reply) => {
      const input = actorSchema.parse(request.query);
      const reporterId = await verifiedActor(request, auth, input.actorId);
      return reply.send(
        safetyReportReceiptSchema.parse(
          await service.getOwnSafetyReport(reporterId, request.params.reportId),
        ),
      );
    },
  );

  app.post('/v1/moderation/cases', async (request, reply) => {
    const input = openModerationCaseSchema.parse(request.body);
    const actorId = await verifiedActor(request, auth, input.actorId, true);
    return reply
      .code(201)
      .send(
        moderationCaseSchema.parse(
          await service.openModerationCase(
            actorId,
            input.reportId,
            input.idempotencyKey,
            request.id,
          ),
        ),
      );
  });

  app.patch<{ Params: { caseId: string } }>(
    '/v1/moderation/cases/:caseId',
    async (request, reply) => {
      const input = updateModerationCaseSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      return reply.send(
        moderationCaseSchema.parse(
          await service.updateModerationCase(actorId, request.params.caseId, {
            ...(input.assigneeId !== undefined
              ? { assigneeId: input.assigneeId }
              : {}),
            ...(input.status ? { status: input.status } : {}),
            ...(input.note ? { note: input.note } : {}),
            ...(input.linkedActionId
              ? { linkedActionId: input.linkedActionId }
              : {}),
            expectedVersion: input.expectedVersion,
          }),
        ),
      );
    },
  );

  app.get<{ Params: { caseId: string } }>(
    '/v1/moderation/cases/:caseId',
    async (request, reply) => {
      const input = actorSchema.parse(request.query);
      const actorId = await verifiedActor(request, auth, input.actorId);
      return reply.send(
        await service.getModerationCase(actorId, request.params.caseId),
      );
    },
  );

  app.get<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/moderation/cases',
    async (request, reply) => {
      const input = pageQuerySchema.parse(request.query);
      const actorId = await verifiedActor(request, auth, input.actorId);
      const result = await service.listModerationCases(
        actorId,
        request.params.communityId,
        {
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
      );
      return reply.send({
        items: result.items.map((item) => moderationCaseSchema.parse(item)),
        nextCursor: result.nextCursor,
      });
    },
  );

  app.delete<{ Params: { restrictionId: string } }>(
    '/v1/moderation/restrictions/:restrictionId',
    async (request, reply) => {
      const input = reverseRestrictionSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      return reply.send(
        moderationRestrictionSchema.parse(
          await service.reverseRestriction(
            actorId,
            request.params.restrictionId,
            input.reason,
            input.expectedVersion,
            request.id,
          ),
        ),
      );
    },
  );

  app.get<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/invitations',
    async (request, reply) => {
      const input = actorSchema.parse(request.query);
      const actorId = await verifiedActor(request, auth, input.actorId);
      const invitations = await service.listInvitations(
        actorId,
        request.params.communityId,
      );
      return reply.send(
        invitations.map((invitation) =>
          invitationSchema.parse(publicInvitation(invitation)),
        ),
      );
    },
  );

  app.delete<{ Params: { invitationId: string } }>(
    '/v1/invitations/:invitationId',
    async (request, reply) => {
      const input = revokeInvitationSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      const invitation = await service.revokeInvitation(
        actorId,
        request.params.invitationId,
        input.expectedVersion,
      );
      return reply.send(invitationSchema.parse(publicInvitation(invitation)));
    },
  );

  app.post('/v1/invitations/preview', async (request, reply) => {
    const input = invitationActionSchema.parse(request.body);
    const actorId = await verifiedActor(request, auth, input.actorId, true);
    return reply.send(
      invitationPreviewSchema.parse(
        await service.previewInvitation(actorId, input.token),
      ),
    );
  });

  app.post('/v1/invitations/accept', async (request, reply) => {
    const input = invitationActionSchema.parse(request.body);
    const actorId = await verifiedActor(request, auth, input.actorId, true);
    return reply.send(
      membershipSchema.parse(
        await service.acceptInvitation(actorId, input.token, request.ip),
      ),
    );
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.warn(
      { err: error, correlationId: request.id },
      'request rejected',
    );
    if (error instanceof DomainError) {
      const status =
        error.code === 'rate_limited'
          ? 429
          : error.code === 'forbidden'
            ? 403
            : error.code === 'not_found' ||
                error.code === 'invitation_unavailable'
              ? 404
              : 409;
      return sendApiError(
        reply,
        status,
        error.code,
        request.id,
        status === 429 ? (error.retryAfterSeconds ?? 60) : undefined,
      );
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    )
      return sendApiError(reply, 409, 'conflict', request.id);
    if (error instanceof AuthenticationError) {
      const status =
        error.code === 'rate_limited'
          ? 429
          : error.code === 'identifier_unavailable'
            ? 409
            : 401;
      return sendApiError(
        reply,
        status,
        error.code,
        request.id,
        status === 429 ? 60 : undefined,
      );
    }
    if (error instanceof AuthorizationError)
      return sendApiError(reply, 404, 'not_found', request.id);
    if (error instanceof Error && error.message === 'notification_not_found')
      return sendApiError(reply, 404, 'not_found', request.id);
    if (
      error instanceof Error &&
      error.message === 'invalid_desktop_notification_checkpoint'
    )
      return sendApiError(reply, 400, 'invalid_request', request.id);
    if (
      error instanceof Error &&
      ['stale_notification', 'invalid_notification_cursor'].includes(
        error.message,
      )
    )
      return sendApiError(reply, 409, 'stale_write', request.id);
    if (
      error instanceof Error &&
      error.message === 'notification_preference_not_found'
    )
      return sendApiError(reply, 404, 'not_found', request.id);
    if (
      error instanceof Error &&
      [
        'stale_notification_preference',
        'invalid_notification_preference',
      ].includes(error.message)
    )
      return sendApiError(reply, 409, 'stale_write', request.id);
    if (
      error instanceof Error &&
      error.message === 'notification_read_state_not_found'
    )
      return sendApiError(reply, 404, 'not_found', request.id);
    if (
      error instanceof Error &&
      [
        'invalid_notification_read_state',
        'stale_notification_read_state',
      ].includes(error.message)
    )
      return sendApiError(
        reply,
        error.message === 'invalid_notification_read_state' ? 400 : 409,
        error.message === 'invalid_notification_read_state'
          ? 'invalid_request'
          : 'stale_write',
        request.id,
      );
    if (
      error instanceof Error &&
      error.message === 'web_push_subscription_not_found'
    )
      return sendApiError(reply, 404, 'not_found', request.id);
    if (
      error instanceof Error &&
      error.message === 'invalid_web_push_subscription'
    )
      return sendApiError(reply, 400, 'invalid_request', request.id);
    if (error instanceof CoordinationError)
      return sendApiError(reply, 503, 'dependency_unavailable', request.id, 5);
    if (error instanceof Error && error.message === 'presence_rate_limited')
      return sendApiError(reply, 429, 'rate_limited', request.id, 15);
    if (error instanceof Error && error.message === 'invalid_member_status')
      return sendApiError(reply, 400, 'invalid_request', request.id);
    if (error instanceof Error && error.message === 'stale_member_status')
      return sendApiError(reply, 409, 'stale_write', request.id);
    if (error instanceof Error && error.message === 'mention_message_not_found')
      return sendApiError(reply, 404, 'not_found', request.id);
    if (error instanceof Error && error.message === 'mention_fanout_exceeded')
      return sendApiError(reply, 409, 'conflict', request.id);
    if (error instanceof HttpSecurityError)
      return sendApiError(reply, 403, error.code, request.id);
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      error.statusCode === 413
    )
      return sendApiError(reply, 413, 'payload_too_large', request.id);
    if (
      (error instanceof Error && error.name === 'ZodError') ||
      (typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        error.statusCode === 400)
    )
      return sendApiError(reply, 400, 'invalid_request', request.id);
    return sendApiError(reply, 500, 'internal_error', request.id);
  });

  app.setNotFoundHandler((request, reply) =>
    sendApiError(reply, 404, 'not_found', request.id),
  );

  return app;
}

export interface ExperienceRuntime {
  notifications?: NotificationService;
  notificationPreferences?: NotificationPreferenceService;
  notificationReadState?: NotificationReadService;
  webPush?: WebPushController;
  presence?: PresenceService;
  memberStatus?: MemberStatusService;
  mentions?: MentionRuntime;
}

function sendApiError(
  reply: FastifyReply,
  status: number,
  error: ErrorResponse['error'],
  correlationId: string,
  retryAfterSeconds?: number,
) {
  reply.header('cache-control', 'no-store');
  if (retryAfterSeconds !== undefined)
    reply.header('retry-after', String(retryAfterSeconds));
  return reply.code(status).send({
    version: 1,
    error,
    correlationId,
    retryable: status === 429 || status === 503,
  } satisfies ErrorResponse);
}

function publicInvitation(invitation: {
  id: string;
  communityId: string;
  creatorId: string;
  targetAccountId: string | null;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  useCount: number;
  revokedAt: string | null;
  version: number;
}) {
  return invitation;
}

async function verifiedActor(
  request: Parameters<typeof authenticateRequest>[0],
  auth: AuthRuntime | undefined,
  claimedActorId: string,
  mutation = false,
): Promise<string> {
  if (!auth) return claimedActorId;
  const actorId = (
    await (mutation
      ? authenticateMutation(request, auth)
      : authenticateRequest(request, auth))
  ).account.id;
  if (actorId !== claimedActorId) throw new AuthorizationError('deny');
  return actorId;
}

export interface StorageReadinessResult {
  ready: boolean;
  storage: 'development-memory' | 'postgresql';
  schemaVersion?: number;
}

export interface StorageReadiness {
  check(): Promise<StorageReadinessResult>;
}

const memoryReadiness: StorageReadiness = {
  check: () =>
    Promise.resolve({ ready: true, storage: 'development-memory' as const }),
};
