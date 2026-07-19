import { describe, expect, it } from 'vitest';
import { invitationTokenFromHash } from './invitations.js';

describe('invitation browser flow', () => {
  it('accepts only an opaque token from the URL fragment', () => {
    const token = 'A'.repeat(43);
    expect(invitationTokenFromHash(`#invite=${token}`)).toBe(token);
    expect(invitationTokenFromHash('?invite=not-a-fragment')).toBeUndefined();
    expect(invitationTokenFromHash('#invite=short')).toBeUndefined();
  });
});
