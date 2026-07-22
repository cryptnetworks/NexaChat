import { describe, expect, it } from 'vitest';
import { MAX_LINKS_PER_MESSAGE, safeLinkSegments } from './links.js';

describe('safe rich links', () => {
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
