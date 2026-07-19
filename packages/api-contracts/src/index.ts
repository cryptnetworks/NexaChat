import { z } from 'zod';

const name = z.string().trim().min(1).max(80);
const id = z.string().uuid();

export const createDevAccountSchema = z.object({ displayName: name }).strict();
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
export type CreateCommunityRequest = z.infer<typeof createCommunitySchema>;
export type CreateSpaceRequest = z.infer<typeof createSpaceSchema>;
export type CreateMessageRequest = z.infer<typeof createMessageSchema>;
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
