import { z } from 'zod';

const name = z.string().trim().min(1).max(80);
const id = z.string().uuid();

export const createDevAccountSchema = z.object({ displayName: name }).strict();
export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[\p{L}\p{N}_.-]+$/u);
export const passwordSchema = z.string().min(12).max(128);
export const registrationSchema = z
  .object({
    username: usernameSchema,
    displayName: name,
    password: passwordSchema,
  })
  .strict();
export const loginSchema = z
  .object({ username: usernameSchema, password: passwordSchema })
  .strict();
export const authAccountSchema = z.object({
  id,
  username: usernameSchema,
  displayName: name,
});
export const authSessionSchema = z.object({
  id,
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  recentAuthAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  current: z.boolean(),
});
export const createCommunitySchema = z
  .object({
    ownerId: z.string().uuid(),
    name,
  })
  .strict();
export const createSpaceSchema = z.object({ actorId: id, name }).strict();
export const createMessageSchema = z
  .object({
    authorId: id,
    body: z.string().trim().min(1).max(4000),
  })
  .strict();
export const permissionSchema = z.enum([
  'community.view',
  'community.manage',
  'community.transfer',
  'membership.view',
  'membership.manage',
  'category.view',
  'category.manage',
  'space.view',
  'space.manage',
  'message.create',
  'message.manage',
  'invitation.create',
  'invitation.manage',
  'moderation.ban',
  'moderation.audit',
]);
export const permissionScopeSchema = z.object({
  type: z.enum(['instance', 'community', 'category', 'space', 'resource']),
  id,
});
export const permissionPreviewRequestSchema = z
  .object({
    actorId: id,
    permission: permissionSchema,
    scopes: z.array(permissionScopeSchema).min(1).max(5),
  })
  .strict();
export const permissionPreviewResponseSchema = z.object({
  allowed: z.boolean(),
  permission: permissionSchema,
  reason: z.enum(['owner', 'grant', 'deny', 'missing_grant', 'invalid_actor']),
  scope: permissionScopeSchema.optional(),
});

export const accountSchema = z.object({ id, displayName: name });
export const communitySchema = z.object({ id, ownerId: id, name });
export const spaceSchema = z.object({
  id,
  communityId: id,
  name,
  kind: z.literal('text'),
});
export const messageSchema = z.object({
  id,
  spaceId: id,
  authorId: id,
  body: z.string().min(1).max(4000),
  createdAt: z.string().datetime(),
});

export const errorResponseSchema = z.object({
  error: z.enum([
    'forbidden',
    'internal_error',
    'invalid_request',
    'not_found',
    'authentication_failed',
    'identifier_unavailable',
    'rate_limited',
    'unauthenticated',
    'csrf_rejected',
  ]),
  correlationId: id.optional(),
});

export const websocketClientMessageSchema = z
  .object({
    type: z.literal('subscribe'),
    spaceId: id,
    actorId: id,
  })
  .strict();

export const websocketServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribed'), spaceId: id }),
  z.object({
    type: z.literal('error'),
    error: z.enum([
      'development_only',
      'forbidden',
      'invalid_message',
      'not_found',
    ]),
  }),
]);

export type CreateDevAccountRequest = z.infer<typeof createDevAccountSchema>;
export type RegistrationRequest = z.infer<typeof registrationSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
export type AuthAccountResponse = z.infer<typeof authAccountSchema>;
export type AuthSessionResponse = z.infer<typeof authSessionSchema>;
export type CreateCommunityRequest = z.infer<typeof createCommunitySchema>;
export type CreateSpaceRequest = z.infer<typeof createSpaceSchema>;
export type CreateMessageRequest = z.infer<typeof createMessageSchema>;
export type PermissionPreviewRequest = z.infer<
  typeof permissionPreviewRequestSchema
>;
export type PermissionPreviewResponse = z.infer<
  typeof permissionPreviewResponseSchema
>;
export type AccountResponse = z.infer<typeof accountSchema>;
export type CommunityResponse = z.infer<typeof communitySchema>;
export type SpaceResponse = z.infer<typeof spaceSchema>;
export type MessageResponse = z.infer<typeof messageSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type WebsocketClientMessage = z.infer<
  typeof websocketClientMessageSchema
>;
export type WebsocketServerMessage = z.infer<
  typeof websocketServerMessageSchema
>;
