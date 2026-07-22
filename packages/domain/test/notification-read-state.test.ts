import { describe, expect, it } from 'vitest';
import {
  advanceNotificationReadState,
  type NotificationReadState,
} from '../src/notifications.js';

describe('synchronized notification read state', () => {
  it('is monotonic across devices, retries, and offline reconciliation', async () => {
    let state: NotificationReadState | undefined;
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const store = {
      find: async () => state,
      advance: async (value: NotificationReadState, expected?: number) => {
        if (state?.version !== expected) return undefined;
        state = value;
        return value;
      },
    };
    /* eslint-enable @typescript-eslint/require-await */
    const now = new Date('2026-01-01');
    await advanceNotificationReadState(store, {
      accountId: 'u',
      stream: 'all',
      sequence: 10,
      eventId: 'e10',
      now,
    });
    expect(
      (
        await advanceNotificationReadState(store, {
          accountId: 'u',
          stream: 'all',
          sequence: 4,
          eventId: 'offline',
          now,
        })
      ).sequence,
    ).toBe(10);
    expect(
      (
        await advanceNotificationReadState(store, {
          accountId: 'u',
          stream: 'all',
          sequence: 12,
          eventId: 'e12',
          now,
        })
      ).sequence,
    ).toBe(12);
  });
});
