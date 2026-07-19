const maxForwardedHeaderBytes = 2_048;
const maxForwardedHops = 16;
const maxTrustedProxyCidrs = 32;

interface ParsedAddress {
  family: 4 | 6;
  bytes: Uint8Array;
  canonical: string;
}

interface ParsedCidr {
  family: 4 | 6;
  network: Uint8Array;
  prefix: number;
  canonical: string;
}

export interface ClientAddressResolver {
  resolve(
    remoteAddress: string | undefined,
    forwardedFor: string | readonly string[] | undefined,
  ): string;
}

export function parseTrustedProxyCidrs(
  value: string | undefined,
  required: boolean,
): string[] {
  if (value === undefined || !value.trim()) {
    if (required) throw new Error('must be configured in production');
    return [];
  }
  if (value.length > maxForwardedHeaderBytes)
    throw new Error('must not exceed 2048 bytes');
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length > maxTrustedProxyCidrs || entries.some((entry) => !entry))
    throw new Error('must contain from 1 to 32 comma-separated CIDRs');
  const parsed = entries.map(parseCidr);
  const canonical = parsed.map((entry) => entry.canonical);
  if (new Set(canonical).size !== canonical.length)
    throw new Error('must not contain duplicate CIDRs');
  return canonical;
}

export function createClientAddressResolver(
  trustedProxyCidrs: readonly string[] = [],
): ClientAddressResolver {
  const trusted = trustedProxyCidrs.map(parseCidr);
  return {
    resolve(remoteAddress, forwardedFor) {
      const remote = parseAddress(remoteAddress);
      if (!remote) return 'unknown';
      if (!matchesAny(remote, trusted)) return remote.canonical;
      if (
        typeof forwardedFor !== 'string' ||
        forwardedFor.length > maxForwardedHeaderBytes
      )
        return remote.canonical;
      const rawAddresses = forwardedFor.split(',');
      if (rawAddresses.length === 0 || rawAddresses.length > maxForwardedHops)
        return remote.canonical;
      const forwarded = rawAddresses.map((value) => parseAddress(value.trim()));
      if (forwarded.some((address) => !address)) return remote.canonical;

      let current = remote;
      for (let index = forwarded.length - 1; index >= 0; index -= 1) {
        if (!matchesAny(current, trusted)) break;
        const next = forwarded[index];
        if (!next) return remote.canonical;
        current = next;
      }
      return current.canonical;
    },
  };
}

function parseCidr(value: string): ParsedCidr {
  const separator = value.lastIndexOf('/');
  if (separator <= 0 || separator === value.length - 1)
    throw new Error('each trusted proxy must be an explicit CIDR');
  const address = parseAddress(value.slice(0, separator));
  const prefixText = value.slice(separator + 1);
  if (!address || !/^\d{1,3}$/.test(prefixText))
    throw new Error('each trusted proxy must be a valid CIDR');
  const prefix = Number(prefixText);
  const maximum = address.family === 4 ? 32 : 128;
  if (!Number.isSafeInteger(prefix) || prefix < 8 || prefix > maximum)
    throw new Error('trusted proxy CIDR prefixes must be bounded');
  const network = masked(address.bytes, prefix);
  if (!equalBytes(network, address.bytes))
    throw new Error('trusted proxy CIDRs must use canonical network addresses');
  return {
    family: address.family,
    network,
    prefix,
    canonical: `${canonicalAddress(address.family, network)}/${String(prefix)}`,
  };
}

function matchesAny(address: ParsedAddress, cidrs: readonly ParsedCidr[]) {
  return cidrs.some(
    (cidr) =>
      cidr.family === address.family &&
      equalBytes(masked(address.bytes, cidr.prefix), cidr.network),
  );
}

function masked(bytes: Uint8Array, prefix: number): Uint8Array {
  const result = Uint8Array.from(bytes);
  const completeBytes = Math.floor(prefix / 8);
  const remainingBits = prefix % 8;
  if (remainingBits > 0) {
    const current = result[completeBytes];
    if (current !== undefined)
      result[completeBytes] = current & (0xff << (8 - remainingBits));
  }
  for (
    let index = completeBytes + (remainingBits > 0 ? 1 : 0);
    index < result.length;
    index += 1
  )
    result[index] = 0;
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function parseAddress(value: string | undefined): ParsedAddress | undefined {
  if (!value || value.length > 64 || value !== value.trim()) return undefined;
  const ipv4 = parseIpv4(value);
  if (ipv4)
    return { family: 4, bytes: ipv4, canonical: canonicalAddress(4, ipv4) };
  const ipv6 = parseIpv6(value);
  if (!ipv6) return undefined;
  if (
    ipv6.slice(0, 10).every((byte) => byte === 0) &&
    ipv6[10] === 0xff &&
    ipv6[11] === 0xff
  ) {
    const mapped = ipv6.slice(12);
    return {
      family: 4,
      bytes: mapped,
      canonical: canonicalAddress(4, mapped),
    };
  }
  return { family: 6, bytes: ipv6, canonical: canonicalAddress(6, ipv6) };
}

function parseIpv4(value: string): Uint8Array | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part || !/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const parsed = Number(part);
    if (parsed > 255) return undefined;
    bytes[index] = parsed;
  }
  return bytes;
}

function parseIpv6(value: string): Uint8Array | undefined {
  if (value.includes('%') || !/^[0-9a-fA-F:.]+$/.test(value)) return undefined;
  let expanded = value;
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    const ipv4 = parseIpv4(value.slice(separator + 1));
    if (separator < 0 || !ipv4) return undefined;
    const high = ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0);
    const low = ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0);
    expanded = `${value.slice(0, separator)}:${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = expanded.split('::');
  if (halves.length > 2) return undefined;
  const left = parseIpv6Half(halves[0] ?? '');
  const right = parseIpv6Half(halves[1] ?? '');
  if (!left || !right) return undefined;
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  )
    return undefined;
  const groups = [...left, ...Array<number>(missing).fill(0), ...right];
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function parseIpv6Half(value: string): number[] | undefined {
  if (!value) return [];
  const parts = value.split(':');
  if (parts.some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part))) return undefined;
  return parts.map((part) => Number.parseInt(part, 16));
}

function canonicalAddress(family: 4 | 6, bytes: Uint8Array): string {
  if (family === 4) return [...bytes].join('.');
  const groups: string[] = [];
  for (let index = 0; index < bytes.length; index += 2)
    groups.push(
      (((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16),
    );
  return groups.join(':');
}
