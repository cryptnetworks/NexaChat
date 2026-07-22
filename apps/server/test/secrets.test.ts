import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { safeConfigurationDiagnostic } from '../src/config.js';
import {
  loadFileBackedSecrets,
  validateSecretFilePermissions,
} from '../src/secrets.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('file-backed runtime secrets', () => {
  it.each([
    ['DATABASE_URL', 'DATABASE_URL_FILE'],
    ['REDIS_URL', 'REDIS_URL_FILE'],
    ['S3_ACCESS_KEY', 'S3_ACCESS_KEY_FILE'],
    ['S3_SECRET_KEY', 'S3_SECRET_KEY_FILE'],
  ] as const)('loads %s from its exclusive file source', (target, source) => {
    const path = secretFile('private-value\n');
    const loaded = loadFileBackedSecrets({
      UNRELATED_SETTING: 'preserved',
      [source]: path,
    });

    expect(loaded[target]).toBe('private-value');
    expect(loaded[source]).toBeUndefined();
    expect(loaded.UNRELATED_SETTING).toBe('preserved');
  });

  it('rejects ambiguous direct and file-backed values', () => {
    const path = secretFile('file-value');

    expectDiagnostic(
      () =>
        loadFileBackedSecrets({
          DATABASE_URL: 'direct-private-value',
          DATABASE_URL_FILE: path,
        }),
      'DATABASE_URL_FILE',
      [path, 'direct-private-value', 'file-value'],
    );
  });

  it('rejects non-regular and overly permissive arbitrary files', () => {
    const directory = temporaryDirectory();
    const target = join(directory, 'target');
    const link = join(directory, 'link');
    writeFileSync(target, 'private-value', { mode: 0o600 });
    symlinkSync(target, link);

    expectDiagnostic(
      () => loadFileBackedSecrets({ DATABASE_URL_FILE: link }),
      'DATABASE_URL_FILE',
      [link, target, 'private-value'],
    );

    chmodSync(target, 0o644);
    expectDiagnostic(
      () => loadFileBackedSecrets({ DATABASE_URL_FILE: target }),
      'DATABASE_URL_FILE',
      [target, 'private-value'],
    );
  });

  it('rejects missing, oversized, NUL, and multiline secret values safely', () => {
    const missing = join(temporaryDirectory(), 'missing-private-name');
    const oversized = secretFile('x'.repeat(65_537));
    const nul = secretFile('private\0value');
    const multiline = secretFile('private\nvalue');
    const invalidUtf8 = secretFile(Buffer.from([0xc3, 0x28]));

    for (const path of [missing, oversized, nul, multiline, invalidUtf8])
      expectDiagnostic(
        () => loadFileBackedSecrets({ S3_SECRET_KEY_FILE: path }),
        'S3_SECRET_KEY_FILE',
        [path, 'private', 'x'.repeat(100)],
      );
  });

  it('accepts read-only mounted secrets independently of the host owner', () => {
    expect(() => {
      validateSecretFilePermissions(
        '/run/secrets/database_url',
        0o100444,
        1_001,
        'DATABASE_URL_FILE',
        1_000,
        'linux',
      );
    }).not.toThrow();
    expect(() => {
      validateSecretFilePermissions(
        '/run/secrets/database_url',
        0o100644,
        1_001,
        'DATABASE_URL_FILE',
        1_000,
        'linux',
      );
    }).toThrow(expect.objectContaining({ key: 'DATABASE_URL_FILE' }));
    expect(() => {
      validateSecretFilePermissions(
        '/run/secrets/database_url',
        0o100555,
        1_001,
        'DATABASE_URL_FILE',
        1_000,
        'linux',
      );
    }).toThrow(expect.objectContaining({ key: 'DATABASE_URL_FILE' }));
  });

  it('retains ownership isolation for arbitrary secret files', () => {
    expect(() => {
      validateSecretFilePermissions(
        '/tmp/database_url',
        0o100600,
        1_001,
        'DATABASE_URL_FILE',
        1_000,
        'linux',
      );
    }).toThrow(expect.objectContaining({ key: 'DATABASE_URL_FILE' }));
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'nexa-secret-test-'));
  directories.push(directory);
  return directory;
}

function secretFile(value: string | Uint8Array): string {
  const path = join(temporaryDirectory(), 'secret');
  writeFileSync(path, value, { mode: 0o600 });
  return path;
}

function expectDiagnostic(
  action: () => unknown,
  key: string,
  privateValues: readonly string[],
): void {
  try {
    action();
    throw new Error('expected failure');
  } catch (error) {
    const serialized = JSON.stringify(safeConfigurationDiagnostic(error));
    expect(safeConfigurationDiagnostic(error).key).toBe(key);
    for (const value of privateValues) expect(serialized).not.toContain(value);
  }
}
