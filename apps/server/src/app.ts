import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  communitySchema,
  createCommunitySchema,
  createMessageSchema,
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
      const actorId = (await authenticateRequest(request, auth)).account.id;
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

  app.post<{ Params: { communityId: string } }>(
    '/v1/communities/:communityId/spaces',
    async (request, reply) => {
      const input = createSpaceSchema.parse(request.body);
      if (authorization && auth) {
        const actorId = (await authenticateRequest(request, auth)).account.id;
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
            ),
          ),
        );
    },
  );

  app.post<{ Params: { spaceId: string } }>(
    '/v1/spaces/:spaceId/messages',
    async (request, reply) => {
      const input = createMessageSchema.parse(request.body);
      if (authorization && auth) {
        const actorId = (await authenticateRequest(request, auth)).account.id;
        if (actorId !== input.authorId) throw new AuthorizationError('deny');
      }
      const message = await service.postMessage(
        request.params.spaceId,
        input.authorId,
        input.body,
      );
      const event: RealtimeEnvelope = {
        version: 1,
        id: randomUUID(),
        type: 'message.created',
        occurredAt: new Date().toISOString(),
        correlationId: request.id,
        payload: { message },
      };
      app.websocketHub?.broadcast(request.params.spaceId, event);
      return reply.code(201).send(messageSchema.parse(message));
    },
  );

  app.setErrorHandler((error, request, reply) => {
    request.log.warn(
      { err: error, correlationId: request.id },
      'request rejected',
    );
    if (error instanceof DomainError) {
      return reply
        .code(error.code === 'forbidden' ? 403 : 404)
        .send({ error: error.code, correlationId: request.id });
    }
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
