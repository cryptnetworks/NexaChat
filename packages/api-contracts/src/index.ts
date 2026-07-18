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
export const actorSchema = z.object({ actorId: id }).strict();
export const pageQuerySchema = z
  .object({
    actorId: id,
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z
      .string()
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();
export const versionedNameSchema = z
  .object({ actorId: id, name, expectedVersion: z.number().int().positive() })
  .strict();
export const membershipStatusSchema = z.enum([
  'active',
  'invited',
  'left',
  'removed',
  'suspended',
]);
export const changeMembershipSchema = z
  .object({
    actorId: id,
    accountId: id,
    status: membershipStatusSchema,
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
export const createCategorySchema = z.object({ actorId: id, name }).strict();
export const updateCategorySchema = z
  .object({
    actorId: id,
    name: name.optional(),
    position: z.number().int().nonnegative().optional(),
    archived: z.boolean().optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const createSpaceSchema = z
  .object({ actorId: id, name, categoryId: id.nullable().optional() })
  .strict();
export const updateSpaceSchema = z
  .object({
    actorId: id,
    name: name.optional(),
    position: z.number().int().nonnegative().optional(),
    categoryId: id.nullable().optional(),
    archived: z.boolean().optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const createMessageSchema = z
  .object({
    authorId: id,
    body: z.string().min(1).max(4000),
    idempotencyKey: z.string().min(8).max(128).optional(),
    replyToId: id.nullable().optional(),
  })
  .strict();
export const updateMessageSchema = z
  .object({
    actorId: id,
    body: z.string().min(1).max(4000),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const deleteMessageSchema = z
  .object({ actorId: id, expectedVersion: z.number().int().positive() })
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
export const communitySchema = z.object({
  id,
  ownerId: id,
  name,
  archivedAt: z.string().datetime().nullable(),
  version: z.number().int().positive(),
});
export const membershipSchema = z.object({
  id,
  communityId: id,
  accountId: id,
  status: membershipStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
});
export const categorySchema = z.object({
  id,
  communityId: id,
  name,
  position: z.number().int().nonnegative(),
  archivedAt: z.string().datetime().nullable(),
  version: z.number().int().positive(),
});
export const spaceSchema = z.object({
  id,
  communityId: id,
  name,
  kind: z.literal('text'),
  categoryId: id.nullable(),
  position: z.number().int().nonnegative(),
  archivedAt: z.string().datetime().nullable(),
  version: z.number().int().positive(),
});
export const communityPageSchema = z.object({
  items: z.array(communitySchema),
  nextCursor: z.string().nullable(),
});
export const spacePageSchema = z.object({
  items: z.array(spaceSchema),
  nextCursor: z.string().nullable(),
});
export const messageSchema = z.object({
  id,
  spaceId: id,
  authorId: id,
  body: z.string().min(1).max(4000).nullable(),
  replyToId: id.nullable(),
  idempotencyKey: z.string().min(8).max(128),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
  version: z.number().int().positive(),
});
export const messagePageSchema = z.object({
  items: z.array(messageSchema),
  nextCursor: z.string().nullable(),
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
    'conflict',
    'stale_write',
    'sole_owner',
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
export type UpdateSpaceRequest = z.infer<typeof updateSpaceSchema>;
export type CreateCategoryRequest = z.infer<typeof createCategorySchema>;
export type UpdateCategoryRequest = z.infer<typeof updateCategorySchema>;
export type ChangeMembershipRequest = z.infer<typeof changeMembershipSchema>;
export type CreateMessageRequest = z.infer<typeof createMessageSchema>;
export type UpdateMessageRequest = z.infer<typeof updateMessageSchema>;
export type PermissionPreviewRequest = z.infer<
  typeof permissionPreviewRequestSchema
>;
export type PermissionPreviewResponse = z.infer<
  typeof permissionPreviewResponseSchema
>;
export type AccountResponse = z.infer<typeof accountSchema>;
export type CommunityResponse = z.infer<typeof communitySchema>;
export type MembershipResponse = z.infer<typeof membershipSchema>;
export type CategoryResponse = z.infer<typeof categorySchema>;
export type SpaceResponse = z.infer<typeof spaceSchema>;
export type MessageResponse = z.infer<typeof messageSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type WebsocketClientMessage = z.infer<
  typeof websocketClientMessageSchema
>;
export type WebsocketServerMessage = z.infer<
  typeof websocketServerMessageSchema
>;
