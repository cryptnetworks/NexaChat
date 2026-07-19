import { describe, expect, it } from 'vitest';
import {
  createClientAddressResolver,
  parseTrustedProxyCidrs,
} from '../src/client-address.js';

describe('trusted proxy client addresses', () => {
  it('ignores forwarded addresses from untrusted peers', () => {
    const resolver = createClientAddressResolver(['10.0.0.0/8']);

    expect(resolver.resolve('192.0.2.10', '198.51.100.7, 10.0.0.4')).toBe(
      '192.0.2.10',
    );
  });

  it('walks trusted hops from right to left and stops at the trust boundary', () => {
    const edgeOnly = createClientAddressResolver(['10.0.0.2/32']);
    const fullChain = createClientAddressResolver([
      '10.0.0.0/8',
      'fd00:0:0:0:0:0:0:0/8',
    ]);

    expect(edgeOnly.resolve('10.0.0.2', '198.51.100.7, 10.0.0.3')).toBe(
      '10.0.0.3',
    );
    expect(fullChain.resolve('10.0.0.2', '198.51.100.7, 10.0.0.3')).toBe(
      '198.51.100.7',
    );
    expect(
      fullChain.resolve('fd00::2', '2001:db8::7, fd00:0:0:0:0:0:0:3'),
    ).toBe('2001:db8:0:0:0:0:0:7');
  });

  it('fails closed for malformed, ambiguous, array, and oversized forwarding', () => {
    const resolver = createClientAddressResolver(['127.0.0.1/32']);

    expect(resolver.resolve('127.0.0.1', 'unknown')).toBe('127.0.0.1');
    expect(resolver.resolve('127.0.0.1', ['198.51.100.7'])).toBe('127.0.0.1');
    expect(resolver.resolve('127.0.0.1', '198.51.100.007')).toBe('127.0.0.1');
    expect(resolver.resolve('127.0.0.1', 'x'.repeat(2_049))).toBe('127.0.0.1');
    expect(
      resolver.resolve(
        '127.0.0.1',
        Array.from({ length: 17 }, () => '198.51.100.7').join(','),
      ),
    ).toBe('127.0.0.1');
  });

  it('canonicalizes IPv4-mapped and equivalent IPv6 addresses', () => {
    const resolver = createClientAddressResolver(['127.0.0.1/32']);

    expect(resolver.resolve('::ffff:127.0.0.1', '2001:0db8::1')).toBe(
      '2001:db8:0:0:0:0:0:1',
    );
  });

  it('validates bounded canonical CIDR configuration', () => {
    expect(parseTrustedProxyCidrs('10.0.0.0/8, fd00::/8', true)).toEqual([
      '10.0.0.0/8',
      'fd00:0:0:0:0:0:0:0/8',
    ]);
    expect(() => parseTrustedProxyCidrs(undefined, true)).toThrow(
      'configured in production',
    );
    expect(() => parseTrustedProxyCidrs('0.0.0.0/0', true)).toThrow(
      'prefixes must be bounded',
    );
    expect(() => parseTrustedProxyCidrs('10.0.0.1/8', true)).toThrow(
      'canonical network',
    );
    expect(() => parseTrustedProxyCidrs('10.0.0.0/8,10.0.0.0/8', true)).toThrow(
      'duplicate',
    );
  });
});
