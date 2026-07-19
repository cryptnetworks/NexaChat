import { randomUUID } from 'node:crypto';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
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
import { Telemetry, type TraceContext } from './telemetry.js';
import { createClientAddressResolver } from './client-address.js';

declare module 'fastify' {
  interface FastifyInstance {
    drainHttp?: () => Promise<void>;
  }
  interface FastifyRequest {
    clientAddress: string;
  }
}

export function buildApp(
  service: CommunityService = new InMemoryCommunityService(),
  readiness: StorageReadiness = memoryReadiness,
  auth?: AuthRuntime,
  authorization?: AuthorizationService,
  serverConfig?: RuntimeConfig['server'],
  telemetry: Telemetry = new Telemetry({ traceSampleRate: 0 }),
): FastifyInstance {
  const clientAddresses = createClientAddressResolver(
    serverConfig?.trustedProxyCidrs,
  );
  const app = Fastify({
    bodyLimit: serverConfig?.bodyLimitBytes ?? 16_384,
    requestTimeout: serverConfig?.requestTimeoutMs ?? 15_000,
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: serverConfig?.logLevel ?? 'info',
      base: { service: 'nexa-chat' },
      redact: [
        'err',
        'error',
        'req',
        'res',
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.x-nexa-csrf',
        'req.body.password',
        'req.body.token',
        'req.body.inviteToken',
        'req.body.body',
        'req.body.content',
        'req.body.bytes',
        'req.body.username',
        'req.body.displayName',
        'req.query.token',
        'res.headers.set-cookie',
        'password',
        'token',
        'cookie',
        'authorization',
        'message.body',
        'attachment.bytes',
      ],
      ...(auth?.logStream ? { stream: auth.logStream } : {}),
    },
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });
  app.decorateRequest('clientAddress', 'unknown');
  telemetry.setLogSink((record) => {
    if (
      (record.event === 'dependency.state_changed' &&
        record.status === 'degraded') ||
      record.event === 'dependency.close_forced'
    )
      app.log.warn(record, 'dependency degraded');
    else app.log.info(record, 'telemetry event');
  });
  const requestLimit = serverConfig?.rateLimit ?? 1_000;
  const requestWindowMs = serverConfig?.rateWindowMs ?? 60_000;
  const requestBuckets = new Map<
    string,
    { count: number; startedAt: number }
  >();
  const requestStartedAt = new WeakMap<object, number>();
  const requestContexts = new WeakMap<object, TraceContext>();
  const applicationRequests = new WeakSet<object>();
  const finalizedRequests = new WeakSet<object>();
  const httpDrainWaiters = new Set<() => void>();
  let activeRequests = 0;
  let activeApplicationRequests = 0;
  const finalizeRequest = (
    request: FastifyRequest,
    statusCode: number,
  ):
    | { durationMs: number; route: string; traceId: string | undefined }
    | undefined => {
    if (finalizedRequests.has(request)) return undefined;
    finalizedRequests.add(request);
    const startedAt = requestStartedAt.get(request) ?? Date.now();
    requestStartedAt.delete(request);
    const context = requestContexts.get(request);
    requestContexts.delete(request);
    activeRequests = Math.max(0, activeRequests - 1);
    if (applicationRequests.delete(request)) {
      activeApplicationRequests = Math.max(0, activeApplicationRequests - 1);
      if (activeApplicationRequests === 0) {
        for (const resolve of httpDrainWaiters) resolve();
        httpDrainWaiters.clear();
      }
    }
    telemetry.activeRequests(activeRequests);
    const durationMs = Date.now() - startedAt;
    const route = request.routeOptions.url ?? 'unmatched';
    telemetry.recordHttp(request.method, route, statusCode, durationMs);
    telemetry.completeRequestSpan(
      statusCode >= 500 || statusCode === 499 ? 'failure' : 'success',
      durationMs,
      context,
    );
    return { durationMs, route, traceId: context?.traceId };
  };
  app.drainHttp = () =>
    activeApplicationRequests === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          httpDrainWaiters.add(resolve);
        });
  app.addHook('onRequest', (request, reply, done) => {
    request.clientAddress = clientAddresses.resolve(
      request.raw.socket.remoteAddress,
      request.headers['x-forwarded-for'],
    );
    const traceparent = Array.isArray(request.headers.traceparent)
      ? request.headers.traceparent[0]
      : request.headers.traceparent;
    const context = telemetry.createContext(traceparent, request.id);
    telemetry.enter(context);
    requestContexts.set(request, context);
    reply.header('x-request-id', request.id);
    reply.header('x-api-version', '1');
    reply.header('traceparent', telemetry.traceparent(context));
    activeRequests += 1;
    requestStartedAt.set(request, Date.now());
    telemetry.activeRequests(activeRequests);
    request.log.info(
      {
        event: 'http.request.started',
        correlationId: request.id,
        traceId: context.traceId,
        method: request.method,
      },
      'request started',
    );
    const operationalRequest = isOperationalRequest(request.url);
    if (readiness.isDraining?.() && !operationalRequest) {
      request.log.warn(
        {
          event: 'http.request.rejected',
          correlationId: request.id,
          traceId: context.traceId,
          errorType: 'lifecycle',
          errorCode: 'server_draining',
        },
        'request rejected',
      );
      sendApiError(reply, 503, 'dependency_unavailable', request.id);
      done();
      return;
    }
    if (operationalRequest) {
      done();
      return;
    }
    const now = Date.now();
    const current = requestBuckets.get(request.clientAddress);
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
    requestBuckets.set(request.clientAddress, {
      ...bucket,
      count: bucket.count + 1,
    });
    if (requestBuckets.size > 10_000) {
      const oldest = requestBuckets.keys().next().value;
      if (oldest) requestBuckets.delete(oldest);
    }
    applicationRequests.add(request);
    activeApplicationRequests += 1;
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const completed = finalizeRequest(request, reply.statusCode);
    if (!completed) {
      done();
      return;
    }
    request.log.info(
      {
        event: 'http.request.completed',
        correlationId: request.id,
        traceId: completed.traceId,
        method: request.method,
        route: completed.route,
        statusCode: reply.statusCode,
        durationMs: completed.durationMs,
      },
      'request completed',
    );
    done();
  });

  app.addHook('onRequestAbort', (request, done) => {
    const completed = finalizeRequest(request, 499);
    if (completed)
      request.log.warn(
        {
          event: 'http.request.aborted',
          correlationId: request.id,
          traceId: completed.traceId,
          method: request.method,
          route: completed.route,
          statusCode: 499,
          durationMs: completed.durationMs,
        },
        'request aborted',
      );
    done();
  });

  app.get('/health/live', (_request, reply) =>
    reply.header('cache-control', 'no-store').send({ status: 'ok' }),
  );
  app.get('/health/startup', (_request, reply) => {
    const started = readiness.isStarted?.() ?? true;
    return reply
      .header('cache-control', 'no-store')
      .code(started ? 200 : 503)
      .send({ status: started ? 'started' : 'starting' });
  });
  app.get('/health/ready', async (_request, reply) => {
    const result = await readiness.check();
    reply.header('cache-control', 'no-store');
    if (!result.ready) {
      reply.header('retry-after', '5');
    }
    return reply.code(result.ready ? 200 : 503).send({
      status: result.ready
        ? result.degraded
          ? 'degraded'
          : 'ready'
        : 'unavailable',
    });
  });
  app.get('/metrics', (_request, reply) =>
    reply
      .header('cache-control', 'no-store')
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(telemetry.metrics.render()),
  );

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
      const { existing, message } = await telemetry.withSpan(
        'message.command',
        async () => {
          const existing =
            await service.persistence.messages.findByIdempotencyKey(
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
          return { existing, message };
        },
      );
      const event: RealtimeEnvelope = {
        version: 1,
        id: randomUUID(),
        type: 'message.created',
        occurredAt: new Date().toISOString(),
        correlationId: request.id,
        payload: { message },
      };
      if (!existing)
        await telemetry.withSpan('realtime.publish', () => {
          app.websocketHub?.broadcast(request.params.spaceId, event);
        });
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
      const message = await telemetry.withSpan('message.command', () =>
        service.editMessage(
          request.params.messageId,
          actorId,
          input.body,
          input.expectedVersion,
        ),
      );
      const event: RealtimeEnvelope = {
        version: 1,
        id: randomUUID(),
        type: 'message.updated',
        occurredAt: new Date().toISOString(),
        correlationId: request.id,
        payload: { message },
      };
      await telemetry.withSpan('realtime.publish', () => {
        app.websocketHub?.broadcast(message.spaceId, event);
      });
      return reply.send(messageSchema.parse(message));
    },
  );

  app.delete<{ Params: { messageId: string } }>(
    '/v1/messages/:messageId',
    async (request, reply) => {
      const input = deleteMessageSchema.parse(request.body);
      const actorId = await verifiedActor(request, auth, input.actorId, true);
      const message = await telemetry.withSpan('message.command', () =>
        service.deleteMessage(
          request.params.messageId,
          actorId,
          input.expectedVersion,
        ),
      );
      const event: RealtimeEnvelope = {
        version: 1,
        id: randomUUID(),
        type: 'message.deleted',
        occurredAt: new Date().toISOString(),
        correlationId: request.id,
        payload: { message },
      };
      await telemetry.withSpan('realtime.publish', () => {
        app.websocketHub?.broadcast(message.spaceId, event);
      });
      return reply.send(messageSchema.parse(message));
    },
  );

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
        await service.acceptInvitation(
          actorId,
          input.token,
          request.clientAddress,
        ),
      ),
    );
  });

  app.setErrorHandler((error, request, reply) => {
    const diagnostic = safeErrorDiagnostic(error);
    const log = diagnostic.unexpected ? request.log.error : request.log.warn;
    log.call(
      request.log,
      {
        event: 'http.request.rejected',
        correlationId: request.id,
        traceId: telemetry.currentContext()?.traceId,
        errorType: diagnostic.type,
        errorCode: diagnostic.code,
      },
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
        status === 429 ? 60 : undefined,
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
      telemetry.authenticationFailure(error.code);
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
    if (error instanceof AuthorizationError) {
      if (!error.observed) telemetry.authorizationDecision('deny');
      return sendApiError(reply, 404, 'not_found', request.id);
    }
    if (error instanceof HttpSecurityError) {
      telemetry.authenticationFailure(error.code);
      return sendApiError(reply, 403, error.code, request.id);
    }
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
  degraded?: boolean;
  dependencies?: Record<string, 'ok' | 'degraded' | 'disabled'>;
}

export interface StorageReadiness {
  check(): Promise<StorageReadinessResult>;
  isStarted?(): boolean;
  isDraining?(): boolean;
  beginDrain?(): void;
}

const memoryReadiness: StorageReadiness = {
  check: () =>
    Promise.resolve({ ready: true, storage: 'development-memory' as const }),
};

const operationalPaths = new Set([
  '/health/live',
  '/health/startup',
  '/health/ready',
  '/metrics',
]);

function isOperationalRequest(url: string): boolean {
  return operationalPaths.has(url.split('?', 1)[0] ?? '');
}

function safeErrorDiagnostic(error: unknown): {
  type: string;
  code: string;
  unexpected: boolean;
} {
  if (error instanceof AuthenticationError)
    return { type: 'authentication', code: error.code, unexpected: false };
  if (error instanceof AuthorizationError)
    return { type: 'authorization', code: 'denied', unexpected: false };
  if (error instanceof HttpSecurityError)
    return { type: 'request_security', code: error.code, unexpected: false };
  if (error instanceof DomainError)
    return { type: 'domain', code: error.code, unexpected: false };
  if (error instanceof Error && error.name === 'ZodError')
    return { type: 'validation', code: 'invalid_request', unexpected: false };
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    if (error.statusCode === 413)
      return {
        type: 'request',
        code: 'payload_too_large',
        unexpected: false,
      };
    if (error.statusCode === 400)
      return { type: 'validation', code: 'invalid_request', unexpected: false };
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  )
    return { type: 'database', code: 'conflict', unexpected: false };
  return { type: 'internal', code: 'internal_error', unexpected: true };
}
