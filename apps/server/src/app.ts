import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  accountSchema,
  communitySchema,
  createCommunitySchema,
  createDevAccountSchema,
  createMessageSchema,
  createSpaceSchema,
  messageSchema,
  spaceSchema,
} from '@nexa/api-contracts';
import {
  CommunityService,
  DomainError,
  InMemoryCommunityService,
} from '@nexa/domain';
import type { RealtimeEnvelope } from '@nexa/realtime-contracts';

export function buildApp(
  service: CommunityService = new InMemoryCommunityService(),
  readiness: StorageReadiness = memoryReadiness,
): FastifyInstance {
  const app = Fastify({
    logger: {
      redact: ['req.headers.authorization', 'req.headers.cookie', 'body.body'],
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

  app.post('/v1/dev/accounts', async (request, reply) => {
    if (
      process.env.NODE_ENV !== 'development' ||
      process.env.NEXA_ENABLE_DEV_AUTH !== 'true'
    ) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const input = createDevAccountSchema.parse(request.body);
    return reply
      .code(201)
      .send(
        accountSchema.parse(await service.createAccount(input.displayName)),
      );
  });

  app.post('/v1/communities', async (request, reply) => {
    const input = createCommunitySchema.parse(request.body);
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
    if (
      (error instanceof Error && error.name === 'ZodError') ||
      (typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        error.statusCode === 400)
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
