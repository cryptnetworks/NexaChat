import { z } from 'zod';
import { messageSchema } from '@nexa/api-contracts';

export const realtimeEnvelopeSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  type: z.enum(['message.created', 'message.updated', 'message.deleted']),
  occurredAt: z.string().datetime(),
  correlationId: z.string().uuid(),
  payload: z.object({
    message: messageSchema,
  }),
});

export type RealtimeEnvelope = z.infer<typeof realtimeEnvelopeSchema>;
