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
    slowModeSeconds: z.number().int().min(0).max(21_600).optional(),
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
export const createInvitationSchema = z
  .object({
    actorId: id,
    expiresInSeconds: z.number().int().min(60).max(2_592_000),
    maxUses: z.number().int().min(1).max(100),
    targetAccountId: id.nullable().optional(),
  })
  .strict();
export const invitationTokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/);
export const invitationActionSchema = z
  .object({ actorId: id, token: invitationTokenSchema })
  .strict();
export const revokeInvitationSchema = z
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
  'moderation.timeout',
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
  slowModeSeconds: z.number().int().min(0).max(21_600),
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
export const unreadIndicatorSchema = z.object({
  spaceId: id,
  unreadCount: z.number().int().min(0).max(999),
  mentionCount: z.number().int().min(0).max(999),
  lastReadMessageId: id.nullable(),
  version: z.number().int().positive(),
});
export const markReadSchema = z
  .object({
    actorId: id,
    messageId: id.nullable(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
export const reactionKeySchema = z.string().min(1).max(16);
export const reactionMutationSchema = z.object({ actorId: id }).strict();
export const reactionAggregateSchema = z.object({
  key: reactionKeySchema,
  count: z.number().int().positive(),
  reactedByActor: z.boolean(),
});
export const timeoutMemberSchema = z
  .object({
    actorId: id,
    targetAccountId: id,
    durationSeconds: z.number().int().min(60).max(2_592_000),
    reason: z.string().trim().min(1).max(500),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();
export const banMemberSchema = z
  .object({
    actorId: id,
    targetAccountId: id,
    durationSeconds: z
      .number()
      .int()
      .min(60)
      .max(31_536_000)
      .nullable()
      .optional(),
    reason: z.string().trim().min(1).max(500),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();
export const reverseRestrictionSchema = z
  .object({
    actorId: id,
    reason: z.string().trim().min(1).max(500),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const moderationRestrictionSchema = z.object({
  id,
  communityId: id,
  actorId: id,
  targetAccountId: id,
  kind: z.enum(['timeout', 'ban']),
  reason: z.string().min(1).max(500),
  idempotencyKey: z.string().min(8).max(128),
  correlationId: id,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  version: z.number().int().positive(),
});
export const invitationSchema = z.object({
  id,
  communityId: id,
  creatorId: id,
  targetAccountId: id.nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  maxUses: z.number().int().positive(),
  useCount: z.number().int().nonnegative(),
  revokedAt: z.string().datetime().nullable(),
  version: z.number().int().positive(),
});
export const createdInvitationSchema = z.object({
  invitation: invitationSchema,
  token: invitationTokenSchema,
});
export const invitationPreviewSchema = z.object({
  communityId: id,
  communityName: name,
  expiresAt: z.string().datetime(),
});

export const errorResponseSchema = z.object({
  version: z.literal(1),
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
    'invitation_unavailable',
    'payload_too_large',
    'dependency_unavailable',
  ]),
  correlationId: id,
  retryable: z.boolean(),
});

const websocketRequestId = z.string().uuid();
export const websocketClientMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      version: z.literal(1),
      type: z.literal('subscribe'),
      requestId: websocketRequestId,
      spaceId: id,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal('unsubscribe'),
      requestId: websocketRequestId,
      spaceId: id,
    })
    .strict(),
  z.object({ version: z.literal(1), type: z.literal('heartbeat') }).strict(),
]);

export const websocketServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    version: z.literal(1),
    type: z.enum(['subscribed', 'unsubscribed']),
    requestId: websocketRequestId,
    spaceId: id,
  }),
  z.object({
    version: z.literal(1),
    type: z.literal('heartbeat'),
    occurredAt: z.string().datetime(),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal('error'),
    requestId: websocketRequestId.optional(),
    error: z.enum([
      'unauthenticated',
      'unavailable',
      'invalid_message',
      'rate_limited',
      'subscription_limit',
      'server_draining',
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
export type InvitationResponse = z.infer<typeof invitationSchema>;
export type CreatedInvitationResponse = z.infer<typeof createdInvitationSchema>;
export type InvitationPreviewResponse = z.infer<typeof invitationPreviewSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type WebsocketClientMessage = z.infer<
  typeof websocketClientMessageSchema
>;
export type WebsocketServerMessage = z.infer<
  typeof websocketServerMessageSchema
>;
