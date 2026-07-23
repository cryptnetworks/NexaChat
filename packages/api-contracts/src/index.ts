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
export const changePasswordSchema = z
  .object({ currentPassword: passwordSchema, newPassword: passwordSchema })
  .strict();
export const authAccountSchema = z.object({
  id,
  username: usernameSchema,
  displayName: name,
});
export const avatarMetadataSchema = z
  .object({
    objectKey: z
      .string()
      .max(255)
      .regex(/^avatars\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,128}$/),
    mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    byteLength: z.number().int().min(1).max(5_242_880),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const authProfileSchema = authAccountSchema
  .extend({
    avatar: avatarMetadataSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    version: z.number().int().positive(),
  })
  .strict();
export const updateProfileSchema = z
  .object({
    username: usernameSchema.optional(),
    displayName: name.optional(),
    avatar: avatarMetadataSchema.nullable().optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict()
  .refine(
    (input) =>
      input.username !== undefined ||
      input.displayName !== undefined ||
      input.avatar !== undefined,
    { message: 'at least one profile field is required' },
  );
export const authSessionSchema = z.object({
  handle: z.string().regex(/^sess_[A-Za-z0-9_-]{16,27}$/),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  recentAuthAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  current: z.boolean(),
});
export const sessionHandleSchema = z
  .object({ handle: z.string().regex(/^sess_[A-Za-z0-9_-]{16,27}$/) })
  .strict();
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
    direction: z.enum(['forward', 'backward']).optional(),
  })
  .strict();
const auditCursor = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => {
    try {
      const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
      const padded = normalized.padEnd(
        normalized.length + ((4 - (normalized.length % 4)) % 4),
        '=',
      );
      return /^[0-9]+$/u.test(atob(padded));
    } catch {
      return false;
    }
  });
export const auditPageQuerySchema = pageQuerySchema.extend({
  cursor: auditCursor.optional(),
});
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
  'moderation.message.delete',
  'moderation.case',
  'moderation.appeal',
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
export const moderatorDeleteMessageSchema = z
  .object({
    actorId: id,
    reason: z.string().trim().min(1).max(500),
    idempotencyKey: z.string().min(8).max(128),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const reportCategorySchema = z.enum([
  'spam',
  'harassment',
  'threat',
  'self_harm',
  'other',
]);
export const createSafetyReportSchema = z
  .object({
    reporterId: id,
    targetAccountId: id.nullable().optional(),
    targetMessageId: id.nullable().optional(),
    category: reportCategorySchema,
    description: z.string().trim().min(1).max(1000),
    evidenceReferenceIds: z.array(id).max(10).default([]),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict()
  .refine(
    (value) =>
      (value.targetAccountId == null) !== (value.targetMessageId == null),
    { message: 'exactly one report target is required' },
  );
export const safetyReportReceiptSchema = z.object({
  id,
  communityId: id,
  targetAccountId: id.nullable(),
  targetMessageId: id.nullable(),
  category: reportCategorySchema,
  status: z.enum(['submitted', 'triaged', 'actioned', 'dismissed']),
  correlationId: id,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
});
export const openModerationCaseSchema = z
  .object({
    actorId: id,
    reportId: id,
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();
export const updateModerationCaseSchema = z
  .object({
    actorId: id,
    assigneeId: id.nullable().optional(),
    status: z.enum(['open', 'investigating', 'resolved', 'closed']).optional(),
    note: z.string().trim().min(1).max(2000).optional(),
    linkedActionId: id.optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const moderationCaseSchema = z.object({
  id,
  communityId: id,
  reportId: id,
  assigneeId: id.nullable(),
  status: z.enum(['open', 'investigating', 'resolved', 'closed']),
  correlationId: id,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  version: z.number().int().positive(),
});
export const submitAppealSchema = z
  .object({
    appellantId: id,
    restrictionId: id,
    statement: z.string().trim().min(1).max(2000),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();
export const decideAppealSchema = z
  .object({
    reviewerId: id,
    decision: z.enum(['upheld', 'overturned']),
    reason: z.string().trim().min(1).max(2000),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const moderationAppealSchema = z.object({
  id,
  communityId: id,
  appellantId: id,
  restrictionId: id,
  statement: z.string().min(1).max(2000),
  status: z.enum(['submitted', 'upheld', 'overturned']),
  reviewerId: id.nullable(),
  decisionReason: z.string().max(2000).nullable(),
  correlationId: id,
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  version: z.number().int().positive(),
});
export const updateContentLimitsSchema = z
  .object({
    actorId: id,
    messageBodyMax: z.number().int().min(1).max(4000),
    reportDescriptionMax: z.number().int().min(1).max(1000),
    moderationReasonMax: z.number().int().min(1).max(500),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
export const contentLimitsSchema = z.object({
  communityId: id,
  messageBodyMax: z.number().int().min(1).max(4000),
  reportDescriptionMax: z.number().int().min(1).max(1000),
  moderationReasonMax: z.number().int().min(1).max(500),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
});
export const notificationKindSchema = z.enum([
  'mention',
  'reply',
  'invite',
  'moderation_outcome',
]);
export const notificationSchema = z.object({
  id,
  accountId: id,
  kind: notificationKindSchema,
  scopeId: id.nullable(),
  resourceId: id,
  actorIds: z.array(id).min(1).max(20),
  count: z.number().int().min(1).max(10_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  readAt: z.string().datetime().nullable(),
  archivedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  version: z.number().int().positive(),
});
export const notificationPageQuerySchema = pageQuerySchema;
export const notificationPageSchema = z.object({
  items: z.array(notificationSchema).max(100),
  nextCursor: z.string().max(256).nullable(),
});
const desktopNotificationCheckpointSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
export const desktopNotificationPollSchema = z
  .object({
    actorId: id,
    checkpoint: desktopNotificationCheckpointSchema.nullable().default(null),
    initialize: z.boolean().default(false),
  })
  .strict();
export const desktopNotificationDeliverySchema = z.object({
  notificationId: id,
  kind: notificationKindSchema,
  version: z.number().int().positive(),
  route: z.literal('/notifications'),
  checkpoint: desktopNotificationCheckpointSchema,
});
export const desktopNotificationDeliveryPageSchema = z.object({
  items: z.array(desktopNotificationDeliverySchema).max(20),
  checkpoint: desktopNotificationCheckpointSchema.nullable(),
  overflow: z.boolean(),
});
export const updateNotificationSchema = z
  .object({
    actorId: id,
    action: z.enum(['read', 'archive']),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const notificationPreferenceScopeSchema = z.enum([
  'account',
  'community',
  'category',
  'space',
]);
export const notificationPreferenceModeSchema = z.enum([
  'all',
  'mentions',
  'none',
]);
export const notificationPreferenceSchema = z.object({
  accountId: id,
  scopeType: notificationPreferenceScopeSchema,
  scopeId: id,
  mode: notificationPreferenceModeSchema,
  mutedUntil: z.string().datetime().nullable(),
  version: z.number().int().positive(),
  updatedAt: z.string().datetime(),
});
export const updateNotificationPreferenceSchema = z
  .object({
    actorId: id,
    scopeType: notificationPreferenceScopeSchema,
    scopeId: id,
    mode: notificationPreferenceModeSchema,
    mutedUntil: z.string().datetime().nullable(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
export const effectiveNotificationPreferenceQuerySchema = z
  .object({
    actorId: id,
    kind: notificationKindSchema,
    communityId: id.optional(),
    categoryId: id.optional(),
    spaceId: id.optional(),
  })
  .strict();
export const effectiveNotificationPreferenceSchema = z.object({
  deliver: z.boolean(),
  mode: notificationPreferenceModeSchema,
  muted: z.boolean(),
});
const notificationStreamSchema = z
  .string()
  .max(64)
  .regex(/^notifications$|^space:[0-9a-f-]{36}$/i);
export const notificationReadStateSchema = z.object({
  accountId: id,
  stream: notificationStreamSchema,
  sequence: z.number().int().nonnegative(),
  eventId: id,
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
});
export const notificationReadStateQuerySchema = z
  .object({ actorId: id, stream: notificationStreamSchema })
  .strict();
export const advanceNotificationReadStateSchema = z
  .object({
    actorId: id,
    stream: notificationStreamSchema,
    sequence: z.number().int().nonnegative(),
    eventId: id,
  })
  .strict();
export const webPushConfigurationSchema = z.object({
  enabled: z.boolean(),
  publicKey: z.string().max(256).nullable(),
});
export const registerWebPushSubscriptionSchema = z
  .object({
    actorId: id,
    subscription: z
      .object({
        endpoint: z.string().url().max(2048),
        expirationTime: z.number().int().positive().nullable(),
        keys: z
          .object({
            p256dh: z.string().min(16).max(512),
            auth: z.string().min(8).max(256),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export const webPushSubscriptionSchema = z.object({
  id,
  accountId: id,
  endpointHash: z.string().length(64),
  active: z.boolean(),
  expiresAt: z.string().datetime().nullable(),
});
export const revokeWebPushSubscriptionSchema = z
  .object({ actorId: id })
  .strict();
export const presenceStateSchema = z.enum(['online', 'idle', 'offline']);
export const presenceSchema = z.object({
  accountId: id,
  state: presenceStateSchema,
});
export const presenceQuerySchema = z.object({ actorId: id }).strict();
export const presenceHeartbeatSchema = z
  .object({ actorId: id, available: z.boolean() })
  .strict();
export const memberStatusSchema = z.object({
  accountId: id,
  text: z.string().max(160).nullable(),
  expiresAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
});
export const memberStatusQuerySchema = z.object({ actorId: id }).strict();
export const updateMemberStatusSchema = z
  .object({
    actorId: id,
    text: z.string().max(160).nullable(),
    expiresAt: z.string().datetime().nullable(),
    expectedVersion: z.number().int().positive().optional(),
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

const auditHash = z.string().regex(/^[0-9a-f]{64}$/);
export const auditEventSchema = z
  .object({
    version: z.literal(1),
    id,
    actorType: z.enum(['account', 'service']),
    actorId: z.string().min(3).max(128),
    scopeType: z.enum(['community', 'instance']),
    scopeId: id.nullable(),
    targetType: z.enum([
      'account',
      'audit_chain',
      'community',
      'invitation',
      'none',
    ]),
    targetId: id.nullable(),
    action: z.enum([
      'invitation.create',
      'invitation.revoke',
      'invitation.accept',
      'audit.checkpoint',
      'audit.legal_hold.apply',
      'audit.legal_hold.release',
      'account.credentials.change',
      'account.session.revoke',
      'account.sessions.revoke_all',
      'account.sessions.revoke_others',
    ]),
    outcome: z.enum(['succeeded', 'rejected']),
    reasonCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,63}$/)
      .nullable(),
    correlationId: id,
    occurredAt: z.string().datetime(),
    retentionUntil: z.string().datetime(),
    sequence: z.number().int().positive(),
    previousHash: auditHash,
    eventHash: auditHash,
  })
  .strict();
export const auditEventPageSchema = z.object({
  items: z.array(auditEventSchema).max(100),
  nextCursor: z.string().nullable(),
});
export const auditIntegritySchema = z
  .object({
    valid: z.boolean(),
    count: z.number().int().nonnegative(),
    headHash: auditHash.nullable(),
    checkpointSequence: z.number().int().positive().nullable(),
    checkpointHash: auditHash.nullable(),
    checkpointValid: z.boolean(),
  })
  .strict();
export const auditCheckpointSchema = z
  .object({
    id,
    communityId: id,
    sequence: z.number().int().positive(),
    headHash: auditHash,
    actorType: z.enum(['account', 'service']),
    actorId: z.string().min(3).max(128),
    correlationId: id,
    createdAt: z.string().datetime(),
  })
  .strict();
export const auditLegalHoldRequestSchema = z
  .object({
    actorId: id,
    held: z.boolean(),
    reasonCode: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  })
  .strict();
export const auditRetentionSchema = z
  .object({
    policy: z.literal('security_7y'),
    legalHold: z.boolean(),
    eligibleThroughSequence: z.number().int().nonnegative(),
  })
  .strict();

export const errorResponseSchema = z.object({
  version: z.literal(1),
  error: z.enum([
    'forbidden',
    'internal_error',
    'invalid_request',
    'not_found',
    'authentication_failed',
    'identifier_unavailable',
    'invalid_profile',
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
  z
    .object({
      version: z.literal(1),
      type: z.literal('presence_subscribe'),
      requestId: websocketRequestId,
      accountIds: z.array(id).min(1).max(100),
    })
    .strict(),
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
  z.object({
    version: z.literal(1),
    type: z.literal('notification_read'),
    state: notificationReadStateSchema.omit({ accountId: true }),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal('presence_subscribed'),
    requestId: websocketRequestId,
    accountIds: z.array(id).min(1).max(100),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal('presence'),
    presence: presenceSchema,
  }),
  z.object({
    version: z.literal(1),
    type: z.literal('member_status'),
    accountId: id,
    status: memberStatusSchema.omit({ accountId: true }).nullable(),
  }),
]);

export type CreateDevAccountRequest = z.infer<typeof createDevAccountSchema>;
export type RegistrationRequest = z.infer<typeof registrationSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;
export type AuthAccountResponse = z.infer<typeof authAccountSchema>;
export type AvatarMetadata = z.infer<typeof avatarMetadataSchema>;
export type AuthProfileResponse = z.infer<typeof authProfileSchema>;
export type UpdateProfileRequest = z.infer<typeof updateProfileSchema>;
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
export type AuditEventResponse = z.infer<typeof auditEventSchema>;
export type AuditEventPageResponse = z.infer<typeof auditEventPageSchema>;
export type AuditIntegrityResponse = z.infer<typeof auditIntegritySchema>;
export type NotificationResponse = z.infer<typeof notificationSchema>;
export type NotificationPageResponse = z.infer<typeof notificationPageSchema>;
export type DesktopNotificationDelivery = z.infer<
  typeof desktopNotificationDeliverySchema
>;
export type DesktopNotificationDeliveryPage = z.infer<
  typeof desktopNotificationDeliveryPageSchema
>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type WebsocketClientMessage = z.infer<
  typeof websocketClientMessageSchema
>;
export type WebsocketServerMessage = z.infer<
  typeof websocketServerMessageSchema
>;
