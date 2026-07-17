import { z } from 'zod';

export const realtimeEnvelopeSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  type: z.literal('message.created'),
  occurredAt: z.string().datetime(),
  correlationId: z.string().uuid(),
  payload: z.object({
    message: z.object({
      id: z.string().uuid(),
      spaceId: z.string().uuid(),
      authorId: z.string().uuid(),
      body: z.string(),
      createdAt: z.string().datetime(),
    }),
  }),
});

export type RealtimeEnvelope = z.infer<typeof realtimeEnvelopeSchema>;
