import { describe, expect, it } from 'vitest';
import {
  acceptDelivery,
  maximumSeenEventIds,
  reconnectDelay,
} from './realtime.js';

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

  it('bounds duplicate identity retention with deterministic oldest-first eviction', () => {
    const cursor = { sequence: 0, seenEventIds: new Set<string>() };
    for (let sequence = 1; sequence <= maximumSeenEventIds + 10; sequence += 1)
      expect(
        acceptDelivery(cursor, `event-${String(sequence)}`, sequence),
      ).toEqual({ accepted: true, gap: false });

    expect(cursor.seenEventIds.size).toBe(maximumSeenEventIds);
    expect(cursor.seenEventIds.has('event-10')).toBe(false);
    expect(cursor.seenEventIds.has('event-11')).toBe(true);
    expect(
      acceptDelivery(
        cursor,
        `event-${String(maximumSeenEventIds + 10)}`,
        maximumSeenEventIds + 11,
      ),
    ).toEqual({ accepted: false, gap: false });
    expect(acceptDelivery(cursor, 'event-1', 1)).toEqual({
      accepted: true,
      gap: true,
    });
    expect(cursor.seenEventIds.size).toBe(maximumSeenEventIds);
  });
});
