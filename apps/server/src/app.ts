import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
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
} from '@nexa/api-contracts';
import {
  CommunityService,
  DomainError,
  InMemoryCommunityService,
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

export function buildApp(
  service: CommunityService = new InMemoryCommunityService(),
  readiness: StorageReadiness = memoryReadiness,
  auth?: AuthRuntime,
  authorization?: AuthorizationService,
  serverConfig?: RuntimeConfig['server'],
): FastifyInstance {
  const app = Fastify({
    bodyLimit: serverConfig?.bodyLimitBytes ?? 16_384,
    requestTimeout: serverConfig?.requestTimeoutMs ?? 15_000,
    logger: {
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
        'password',
        'token',
        'cookie',
        'authorization',
      ],
      ...(auth?.logStream ? { stream: auth.logStream } : {}),
    },
    genReqId: () => randomUUID(),
  });

  app.get('/health/live', () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const result = await readiness.check();
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
      const event: RealtimeEnvelope = {
        version: 1,
        id: randomUUID(),
        type: 'message.created',
        occurredAt: new Date().toISOString(),
        correlationId: request.id,
        payload: { message },
      };
      if (!existing) app.websocketHub?.broadcast(request.params.spaceId, event);
      return reply.code(201).send(messageSchema.parse(message));
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

  app.setErrorHandler((error, request, reply) => {
    request.log.warn(
      { err: error, correlationId: request.id },
      'request rejected',
    );
    if (error instanceof DomainError) {
      return reply
        .code(
          error.code === 'forbidden'
            ? 403
            : error.code === 'not_found'
              ? 404
              : 409,
        )
        .send({ error: error.code, correlationId: request.id });
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    )
      return reply
        .code(409)
        .send({ error: 'conflict', correlationId: request.id });
    if (error instanceof AuthenticationError) {
      return reply
        .code(
          error.code === 'rate_limited'
            ? 429
            : error.code === 'identifier_unavailable'
              ? 409
              : 401,
        )
        .send({ error: error.code });
    }
    if (error instanceof AuthorizationError)
      return reply
        .code(404)
        .send({ error: 'not_found', correlationId: request.id });
    if (error instanceof HttpSecurityError)
      return reply
        .code(403)
        .send({ error: error.code, correlationId: request.id });
    if (
      (error instanceof Error && error.name === 'ZodError') ||
      (typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        (error.statusCode === 400 || error.statusCode === 413))
    )
      return reply
        .code(400)
        .send({ error: 'invalid_request', correlationId: request.id });
    return reply
      .code(500)
      .send({ error: 'internal_error', correlationId: request.id });
  });

  return app;
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
