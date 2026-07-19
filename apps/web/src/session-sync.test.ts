import { describe, expect, it } from 'vitest';
import { parseSessionSignal } from './session-sync.js';

describe('session synchronization messages', () => {
  it('accepts only bounded messages without session identifiers', () => {
    expect(parseSessionSignal({ type: 'signed_out' })).toBe('signed_out');
    expect(parseSessionSignal({ type: 'sessions_changed' })).toBe(
      'sessions_changed',
    );
    expect(parseSessionSignal({ type: 'credentials_rotated' })).toBe(
      'credentials_rotated',
    );
    expect(
      parseSessionSignal({ type: 'signed_out', sessionId: 'private' }),
    ).toBeUndefined();
    expect(parseSessionSignal({ type: 'unknown' })).toBeUndefined();
    expect(parseSessionSignal('signed_out')).toBeUndefined();
  });
});
