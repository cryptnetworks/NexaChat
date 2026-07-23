import { describe, expect, it } from 'vitest';
import { upsertOrderedMessage } from './ordered-messages.js';

const first = { id: 'a', createdAt: '2026-01-01T00:00:00.000Z', body: 'one' };
const second = { id: 'b', createdAt: '2026-01-01T00:00:01.000Z', body: 'two' };

describe('ordered realtime message updates', () => {
  it('inserts out-of-order messages deterministically without mutating input', () => {
    const current = [second];
    const result = upsertOrderedMessage(current, first);
    expect(result).toEqual([first, second]);
    expect(current).toEqual([second]);
  });

  it('replaces an existing message in place when its ordering key is stable', () => {
    const updated = { ...first, body: 'updated' };
    expect(upsertOrderedMessage([first, second], updated)).toEqual([
      updated,
      second,
    ]);
  });

  it('repositions an existing message when an ordering key changes', () => {
    const moved = { ...first, createdAt: '2026-01-01T00:00:02.000Z' };
    expect(upsertOrderedMessage([first, second], moved)).toEqual([
      second,
      moved,
    ]);
  });

  it('uses identifiers as the stable tie-breaker', () => {
    const laterId = { ...first, id: 'z' };
    expect(upsertOrderedMessage([laterId], first)).toEqual([first, laterId]);
  });
});
