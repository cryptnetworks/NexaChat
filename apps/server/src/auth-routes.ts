import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  authAccountSchema,
  authProfileSchema,
  authSessionSchema,
  loginSchema,
  registrationSchema,
  updateProfileSchema,
} from '@nexa/api-contracts';
import {
  AuthenticationError,
  type AuthenticatedSession,
  type AuthenticationService,
} from '@nexa/auth';

export interface AuthHttpConfig {
  trustedOrigin: string;
  secureCookies: boolean;
  cookieMaxAgeSeconds: number;
}

export interface AuthRuntime {
  service: AuthenticationService;
  config: AuthHttpConfig;
  logStream?: { write(message: string): void };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  runtime: AuthRuntime,
): void {
  app.post('/v1/auth/register', async (request, reply) => {
    enforceOrigin(request, runtime.config);
    const input = registrationSchema.parse(request.body);
    const result = await runtime.service.register({
      ...input,
      source: request.clientAddress,
    });
    setSessionCookie(reply, result.session.token, runtime.config);
    return reply.code(201).send(authAccountSchema.parse(result.account));
  });

  app.post('/v1/auth/login', async (request, reply) => {
    enforceOrigin(request, runtime.config);
    const input = loginSchema.parse(request.body);
    const result = await runtime.service.login({
      ...input,
      source: request.clientAddress,
    });
    setSessionCookie(reply, result.session.token, runtime.config);
    return reply.send(authAccountSchema.parse(result.account));
  });

  app.get('/v1/account', async (request, reply) => {
    const authenticated = await authenticateRequest(request, runtime);
    await request.enforceAccountRateLimit?.(
      authenticated.account.id,
      'authenticated',
    );
    return reply.send(
      authProfileSchema.parse(
        await runtime.service.getProfile(authenticated.account.id),
      ),
    );
  });

  app.patch('/v1/account', async (request, reply) => {
    const authenticated = await authenticateMutation(request, runtime);
    await request.enforceAccountRateLimit?.(
      authenticated.account.id,
      'authenticated',
    );
    const input = updateProfileSchema.parse(request.body);
    return reply.send(
      authProfileSchema.parse(
        await runtime.service.updateProfile(authenticated.account.id, {
          expectedVersion: input.expectedVersion,
          ...(input.username !== undefined ? { username: input.username } : {}),
          ...(input.displayName !== undefined
            ? { displayName: input.displayName }
            : {}),
          ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
        }),
      ),
    );
  });

  app.get('/v1/sessions', async (request, reply) => {
    const authenticated = await authenticateRequest(request, runtime);
    const sessions = await runtime.service.listSessions(
      authenticated.account.id,
    );
    return reply.send(
      sessions.map((session) =>
        authSessionSchema.parse({
          id: session.id,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
          recentAuthAt: session.recentAuthAt,
          expiresAt: session.expiresAt,
          current: session.id === authenticated.session.id,
        }),
      ),
    );
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    enforceOrigin(request, runtime.config);
    enforceCsrf(request);
    const authenticated = await authenticateRequest(request, runtime);
    await runtime.service.logout(authenticated.session.id);
    clearSessionCookie(reply, runtime.config);
    return reply.code(204).send();
  });

  app.post('/v1/auth/logout-all', async (request, reply) => {
    enforceOrigin(request, runtime.config);
    enforceCsrf(request);
    const authenticated = await authenticateRequest(request, runtime);
    await runtime.service.logoutAll(authenticated.account.id);
    clearSessionCookie(reply, runtime.config);
    return reply.code(204).send();
  });
}

export async function authenticateRequest(
  request: FastifyRequest,
  runtime: AuthRuntime,
): Promise<AuthenticatedSession> {
  const token = parseCookies(request.headers.cookie)[
    cookieName(runtime.config)
  ];
  if (!token) throw new AuthenticationError('unauthenticated');
  return runtime.service.authenticate(token);
}

export async function authenticateMutation(
  request: FastifyRequest,
  runtime: AuthRuntime,
): Promise<AuthenticatedSession> {
  enforceOrigin(request, runtime.config);
  enforceCsrf(request);
  return authenticateRequest(request, runtime);
}

function enforceOrigin(request: FastifyRequest, config: AuthHttpConfig): void {
  if (request.headers.origin !== config.trustedOrigin)
    throw new HttpSecurityError('csrf_rejected');
}

function enforceCsrf(request: FastifyRequest): void {
  if (request.headers['x-nexa-csrf'] !== '1')
    throw new HttpSecurityError('csrf_rejected');
}

export class HttpSecurityError extends Error {
  constructor(public readonly code: 'csrf_rejected') {
    super(code);
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header || header.length > 4096) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const index = part.indexOf('=');
      return index < 0
        ? ['', '']
        : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  );
}

export function sessionTokenFromCookie(
  header: string | undefined,
  secureCookies: boolean,
): string | undefined {
  return parseCookies(header)[
    secureCookies ? '__Host-nexa_session' : 'nexa_session'
  ];
}

function cookieAttributes(config: AuthHttpConfig): string {
  return `Path=/; HttpOnly; SameSite=Strict${config.secureCookies ? '; Secure' : ''}`;
}

function cookieName(config: AuthHttpConfig): string {
  return config.secureCookies ? '__Host-nexa_session' : 'nexa_session';
}

function setSessionCookie(
  reply: { header(name: string, value: string): unknown },
  token: string,
  config: AuthHttpConfig,
): void {
  reply.header(
    'set-cookie',
    `${cookieName(config)}=${token}; ${cookieAttributes(config)}; Max-Age=${String(config.cookieMaxAgeSeconds)}`,
  );
}

function clearSessionCookie(
  reply: { header(name: string, value: string): unknown },
  config: AuthHttpConfig,
): void {
  reply.header(
    'set-cookie',
    `${cookieName(config)}=; ${cookieAttributes(config)}; Max-Age=0`,
  );
}
