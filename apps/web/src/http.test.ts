import { describe, expect, it } from 'vitest';
import { publicRequestError } from './http.js';

describe('public HTTP retry errors', () => {
  it('presents bounded server retry timing', () => {
    expect(publicRequestError(429, '12').message).toBe(
      'Request failed (429). Try again in 12 seconds.',
    );
  });

  it.each([null, '0', '3601', 'private-value', '1.5'])(
    'does not repeat invalid Retry-After value %s',
    (value) => {
      const error = publicRequestError(503, value);
      expect(error.message).toBe('Request failed (503).');
    },
  );
});
