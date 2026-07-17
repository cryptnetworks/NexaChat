import { z } from 'zod';

const name = z.string().trim().min(1).max(80);
export const createDevAccountSchema = z.object({ displayName: name });
export const createCommunitySchema = z.object({
  ownerId: z.string().uuid(),
  name,
});
export const createSpaceSchema = z.object({ actorId: z.string().uuid(), name });
export const createMessageSchema = z.object({
  authorId: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
});
