export interface RealtimeCursor {
  sequence: number;
  seenEventIds: Set<string>;
}

export function acceptDelivery(
  cursor: RealtimeCursor,
  eventId: string,
  sequence: number,
): { accepted: boolean; gap: boolean } {
  if (cursor.seenEventIds.has(eventId)) return { accepted: false, gap: false };
  const gap = cursor.sequence > 0 && sequence !== cursor.sequence + 1;
  cursor.sequence = Math.max(cursor.sequence, sequence);
  cursor.seenEventIds.add(eventId);
  return { accepted: true, gap };
}

export function reconnectDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}
