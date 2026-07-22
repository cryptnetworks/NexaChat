import { describe, expect, it } from 'vitest';
import {
  cargoSbom,
  normalizeNpmSbom,
  parseCargoLock,
  SbomValidationError,
} from './sbom.js';

const digest = 'a'.repeat(64);
const timestamp = '2026-07-22T00:00:00.000Z';

describe('release SBOMs', () => {
  it('normalizes random npm identity and ordering deterministically', () => {
    const raw = {
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      serialNumber: 'urn:uuid:random',
      version: 1,
      metadata: { timestamp: 'now', component: { name: 'nexa-chat' } },
      components: [
        { 'bom-ref': 'z@1', name: 'z', version: '1' },
        { 'bom-ref': 'a@1', name: 'a', version: '1' },
      ],
      dependencies: [
        { ref: 'z@1', dependsOn: ['b', 'a'] },
        { ref: 'a@1', dependsOn: [] },
      ],
    };
    const normalized = normalizeNpmSbom(
      raw,
      digest,
      timestamp,
      '/private/repository',
    );
    expect(normalized.serialNumber).toBe(
      'urn:uuid:aaaaaaaa-aaaa-5aaa-aaaa-aaaaaaaaaaaa',
    );
    expect((normalized.metadata as { timestamp: string }).timestamp).toBe(
      timestamp,
    );
    expect(
      (normalized.components as Array<{ name: string }>).map(
        (item) => item.name,
      ),
    ).toEqual(['a', 'z']);
  });

  it('rejects an absolute repository path in generated metadata', () => {
    expect(() =>
      normalizeNpmSbom(
        {
          bomFormat: 'CycloneDX',
          specVersion: '1.6',
          version: 1,
          metadata: { path: '/private/repository' },
          components: [],
        },
        digest,
        timestamp,
        '/private/repository',
      ),
    ).toThrow(SbomValidationError);
  });

  it('creates a sorted Cargo component inventory with registry checksums', () => {
    const packages = parseCargoLock(`version = 4

[[package]]
name = "zeta"
version = "2.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${'b'.repeat(64)}"

[[package]]
name = "nexa-desktop"
version = "0.1.0"

[[package]]
name = "alpha"
version = "1.0.0"
`);
    expect(packages.map((pkg) => pkg.name)).toEqual([
      'alpha',
      'nexa-desktop',
      'zeta',
    ]);
    const sbom = cargoSbom(packages, '0.1.0', digest, timestamp);
    expect(sbom).toMatchObject({
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      version: 1,
    });
    expect(sbom.components).toHaveLength(2);
  });

  it('fails closed on malformed Cargo lock data', () => {
    expect(() =>
      parseCargoLock('[[package]]\nname = "missing-version"\n'),
    ).toThrow('invalid package block');
  });
});
