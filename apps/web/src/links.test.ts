import { describe, expect, it } from 'vitest';
import {
  MAX_LINKS_PER_MESSAGE,
  safeInternalHref,
  safeLinkSegments,
} from './links.js';

describe('safe rich links', () => {
  it('accepts only normalized same-application navigation targets', () => {
    expect(safeInternalHref('/spaces/one?q=test#message')).toBe(
      '/spaces/one?q=test#message',
    );
    for (const value of [
      'https://example.test/path',
      '//example.test/path',
      '/\\example.test/path',
      'javascript:alert(1)',
    ])
      expect(safeInternalHref(value)).toBeUndefined();
  });

  it('allows only explicit http links and leaves unsafe schemes inert', () => {
    expect(
      safeLinkSegments('see https://example.com and javascript:alert(1)'),
    ).toEqual([
      { type: 'text', value: 'see ' },
      {
        type: 'link',
        value: 'https://example.com',
        href: 'https://example.com/',
        label: 'https://example.com',
      },
      { type: 'text', value: ' and javascript:alert(1)' },
    ]);
  });

  it('bounds link processing and visible destination length', () => {
    const value = Array.from(
      { length: MAX_LINKS_PER_MESSAGE + 2 },
      (_, index) => `https://example.com/${String(index)}/${'x'.repeat(100)}`,
    ).join(' ');
    const links = safeLinkSegments(value).filter(
      (part) => part.type === 'link',
    );
    expect(links).toHaveLength(MAX_LINKS_PER_MESSAGE);
    expect(links.every((part) => part.label.length <= 80)).toBe(true);
  });
});
