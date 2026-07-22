import { describe, expect, it } from 'vitest';
import { boundedIndicatorCount, mentionAccountIds } from '../src/unread.js';

describe('unread indicators', () => {
  it('extracts bounded, normalized, unique stable mentions', () => {
    const id = '7A1B2C3D-1111-4111-8111-123456789ABC';
    expect(mentionAccountIds(`<@${id}> again <@${id.toLowerCase()}>`)).toEqual([
      id.toLowerCase(),
    ]);
  });

  it('bounds indicator disclosure and UI work', () => {
    expect(boundedIndicatorCount(10_000)).toBe(999);
    expect(boundedIndicatorCount(-1)).toBe(0);
  });
});
