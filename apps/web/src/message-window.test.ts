import { describe, expect, it } from 'vitest';
import {
  maximumLiveMessages,
  mergeMessageWindow,
  upsertMessageWindow,
} from './message-window.js';

function message(
  index: number,
  body: string | null = `message-${String(index)}`,
): { id: string; createdAt: string; body: string | null } {
  return {
    id: String(index).padStart(6, '0'),
    createdAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    body,
  };
}

describe('bounded message windows', () => {
  it('retains the newest deterministic window for realtime updates', () => {
    let current = Array.from({ length: maximumLiveMessages }, (_, index) =>
      message(index),
    );
    current = upsertMessageWindow(current, message(maximumLiveMessages));
    expect(current).toHaveLength(maximumLiveMessages);
    expect(current[0]?.id).toBe('000001');
    expect(current.at(-1)?.id).toBe('000200');
  });

  it('retains the oldest deterministic window while the reader loads history', () => {
    const current = Array.from({ length: 150 }, (_, index) =>
      message(index + 50),
    );
    const older = Array.from({ length: 100 }, (_, index) => message(index));
    const merged = mergeMessageWindow(current, older, 'oldest', 200);
    expect(merged).toHaveLength(200);
    expect(merged[0]?.id).toBe('000000');
    expect(merged.at(-1)?.id).toBe('000199');
  });

  it('updates tombstones without duplicating a message identifier', () => {
    const current = [message(1), message(2)];
    const tombstone = { ...message(2), body: null };
    expect(mergeMessageWindow(current, [tombstone])).toEqual([
      message(1),
      tombstone,
    ]);
  });

  it('keeps its bound across a long mixed realtime sequence', () => {
    let current: ReturnType<typeof message>[] = [];
    for (let index = 0; index < 50_000; index += 1) {
      const id = index % 3 === 0 ? Math.max(0, index - 1) : index;
      current = upsertMessageWindow(
        current,
        message(
          id,
          index % 7 === 0
            ? null
            : index % 5 === 0
              ? `updated-${String(index)}`
              : undefined,
        ),
      );
    }
    expect(current).toHaveLength(maximumLiveMessages);
    expect(new Set(current.map((value) => value.id)).size).toBe(
      maximumLiveMessages,
    );
  });
});
