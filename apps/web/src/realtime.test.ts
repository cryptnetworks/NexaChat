import { describe, expect, it } from 'vitest';
import { acceptDelivery, reconnectDelay } from './realtime.js';

describe('realtime reconnect and reconciliation', () => {
  it('detects gaps, ignores duplicate event identifiers, and advances monotonically', () => {
    const cursor = { sequence: 0, seenEventIds: new Set<string>() };
    expect(acceptDelivery(cursor, 'one', 1)).toEqual({
      accepted: true,
      gap: false,
    });
    expect(acceptDelivery(cursor, 'one', 2)).toEqual({
      accepted: false,
      gap: false,
    });
    expect(acceptDelivery(cursor, 'three', 3)).toEqual({
      accepted: true,
      gap: true,
    });
    expect(acceptDelivery(cursor, 'late', 2)).toEqual({
      accepted: true,
      gap: true,
    });
    expect(cursor.sequence).toBe(3);
  });

  it('uses bounded exponential reconnect delays with jitter', () => {
    expect(reconnectDelay(1, () => 0)).toBe(375);
    expect(reconnectDelay(2, () => 0.5)).toBe(1_000);
    expect(reconnectDelay(20, () => 1)).toBe(37_500);
  });
});
