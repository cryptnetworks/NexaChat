export const MAX_INDICATOR_COUNT = 999;

export interface ReadPosition {
  accountId: string;
  spaceId: string;
  lastReadMessageId: string | null;
  lastReadAt: string;
  version: number;
}

export interface UnreadIndicator {
  spaceId: string;
  unreadCount: number;
  mentionCount: number;
  lastReadMessageId: string | null;
  version: number;
}

/** Extracts explicit, stable account mentions; display names are never identity. */
export function mentionAccountIds(body: string): string[] {
  const ids = new Set<string>();
  const expression =
    /<@([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})>/giu;
  for (const match of body.matchAll(expression)) {
    const id = match[1];
    if (id) ids.add(id.toLowerCase());
    if (ids.size === 100) break;
  }
  return [...ids].sort();
}

export function boundedIndicatorCount(value: number): number {
  return Math.min(MAX_INDICATOR_COUNT, Math.max(0, Math.trunc(value)));
}
