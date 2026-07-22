import { describe, expect, it } from 'vitest';
import { contentDigest, evaluateSpamSignals } from '../src/spam.js';

describe('spam detection primitives', () => {
  it('emits bounded explainable signals without retaining content', () => {
    const now = new Date('2026-01-01T00:00:10.000Z');
    const digest = contentDigest('Repeated Message');
    const result = evaluateSpamSignals(
      ' repeated   message ',
      [
        { occurredAt: '2026-01-01T00:00:08.000Z', contentDigest: digest },
        { occurredAt: '2026-01-01T00:00:09.000Z', contentDigest: digest },
      ],
      { windowSeconds: 10, floodThreshold: 3, repetitionThreshold: 3 },
      now,
    );
    expect(result.map((signal) => signal.explanationCode)).toEqual([
      'message_rate_exceeded',
      'content_digest_repeated',
    ]);
    expect(JSON.stringify(result)).not.toContain('Repeated Message');
    expect(result.every((signal) => signal.score <= 100)).toBe(true);
  });

  it('rejects unsafe operator rules instead of silently widening bounds', () => {
    expect(() =>
      evaluateSpamSignals(
        'value',
        [],
        { windowSeconds: 1, floodThreshold: 1, repetitionThreshold: 1 },
        new Date(),
      ),
    ).toThrow('invalid_spam_rules');
  });
});
