import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  websocketClientMessageSchema,
  websocketServerMessageSchema,
} from '@nexa/api-contracts';
import { realtimeDeliverySchema } from './index.js';

describe('realtime protocol contracts', () => {
  it('accepts strict versioned control messages and rejects identity claims', () => {
    const command = {
      version: 1,
      type: 'subscribe',
      requestId: randomUUID(),
      spaceId: randomUUID(),
    };
    expect(websocketClientMessageSchema.safeParse(command).success).toBe(true);
    expect(
      websocketClientMessageSchema.safeParse({
        ...command,
        actorId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      websocketClientMessageSchema.safeParse({ ...command, version: 2 })
        .success,
    ).toBe(false);
  });

  it('accepts only bounded safe server controls and ordered event deliveries', () => {
    expect(
      websocketServerMessageSchema.safeParse({
        version: 1,
        type: 'error',
        error: 'unavailable',
      }).success,
    ).toBe(true);
    expect(
      websocketServerMessageSchema.safeParse({
        version: 1,
        type: 'error',
        error: 'postgres_failure_detail',
      }).success,
    ).toBe(false);
    expect(
      realtimeDeliverySchema.safeParse({
        version: 1,
        type: 'event',
        spaceId: randomUUID(),
        sequence: 0,
        event: {},
      }).success,
    ).toBe(false);
  });
});
