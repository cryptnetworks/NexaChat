import { generateKeyPairSync } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactValidationError,
  assembleBundle,
  signBundle,
  verifyBundle,
} from './artifact-bundle.js';

const roots: string[] = [];
const identity = {
  version: '0.1.0',
  channel: 'beta' as const,
  platform: 'linux' as const,
  arch: 'x64' as const,
};
const commit = '0123456789abcdef0123456789abcdef01234567';

async function createFixture(): Promise<{
  root: string;
  bundle: string;
  privateKey: string;
  publicKey: string;
}> {
  const root = await mkdtemp(resolve(tmpdir(), 'nexa-artifacts-'));
  roots.push(root);
  const bundle = resolve(root, 'bundle');
  await mkdir(resolve(root, 'apps/desktop/src-tauri'), { recursive: true });
  await mkdir(bundle);
  await writeFile(
    resolve(root, 'package.json'),
    '{"name":"nexa-chat","version":"0.1.0"}\n',
  );
  await writeFile(
    resolve(root, 'package-lock.json'),
    '{"lockfileVersion":3}\n',
  );
  await writeFile(
    resolve(root, 'apps/desktop/src-tauri/Cargo.lock'),
    'version = 4\n',
  );
  await writeFile(
    resolve(bundle, 'NexaChat-0.1.0-beta-linux-x64.AppImage'),
    'synthetic executable fixture\n',
  );
  const sbom = JSON.stringify({
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    components: [],
  });
  await writeFile(
    resolve(bundle, 'NexaChat-0.1.0-desktop-cargo.cdx.json'),
    sbom,
  );
  await writeFile(resolve(bundle, 'NexaChat-0.1.0-source-npm.cdx.json'), sbom);
  const keys = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const privateKey = resolve(root, 'private.pem');
  const publicKey = resolve(root, 'public.pem');
  await writeFile(privateKey, keys.privateKey, { mode: 0o600 });
  await writeFile(publicKey, keys.publicKey, { mode: 0o644 });
  return { root, bundle, privateKey, publicKey };
}

async function assemble(root: string, bundle: string): Promise<void> {
  await assembleBundle({
    ...identity,
    directory: bundle,
    repositoryRoot: root,
    commit,
    sourceDateEpoch: 1_753_158_400,
    builderId: 'urn:nexa:builder:test',
    invocationId: 'artifact-test-1',
  });
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { recursive: true })),
  );
});

describe('release artifact bundle', () => {
  it('verifies the retained test-only signing evidence', async () => {
    const fixtureRoot = resolve(import.meta.dirname, 'fixtures/test-signing');
    const verified = await verifyBundle({
      version: '0.1.0',
      channel: 'beta',
      platform: 'macos',
      arch: 'arm64',
      directory: resolve(fixtureRoot, 'bundle'),
      trustedPublicKey: resolve(fixtureRoot, 'trusted-test-public.pem'),
      keyEnvironment: 'test',
      commit: '80b16a2a1e043f650ebb643476af0954d34f3558',
    });
    expect(verified.keyId).toBe(
      'sha256:b9b4e9287c02eb74e8c00211df083af35fa6c0cfd2ab794271a5c7999adc11e7',
    );
  });

  it('assembles deterministic checksums, provenance, and a manifest', async () => {
    const fixture = await createFixture();
    await assemble(fixture.root, fixture.bundle);
    const first = await readFile(
      resolve(fixture.bundle, 'release-manifest.json'),
      'utf8',
    );
    await assemble(fixture.root, fixture.bundle);
    expect(
      await readFile(resolve(fixture.bundle, 'release-manifest.json'), 'utf8'),
    ).toBe(first);
    expect(first).toContain('0123456789abcdef0123456789abcdef01234567');
    expect(first).not.toContain(fixture.root);
  });

  it('creates and independently verifies a deterministic Ed25519 signature', async () => {
    const fixture = await createFixture();
    await assemble(fixture.root, fixture.bundle);
    const signed = await signBundle({
      ...identity,
      directory: fixture.bundle,
      privateKey: fixture.privateKey,
      keyEnvironment: 'test',
      commit,
    });
    const verified = await verifyBundle({
      ...identity,
      directory: fixture.bundle,
      trustedPublicKey: fixture.publicKey,
      keyEnvironment: 'test',
      commit,
    });
    expect(verified).toEqual(signed);
    await signBundle({
      ...identity,
      directory: fixture.bundle,
      privateKey: fixture.privateKey,
      keyEnvironment: 'test',
      commit,
    });
  });

  it('rejects payload corruption and undeclared files', async () => {
    const fixture = await createFixture();
    await assemble(fixture.root, fixture.bundle);
    await signBundle({
      ...identity,
      directory: fixture.bundle,
      privateKey: fixture.privateKey,
      keyEnvironment: 'test',
      commit,
    });
    await writeFile(
      resolve(fixture.bundle, 'NexaChat-0.1.0-beta-linux-x64.AppImage'),
      'tampered',
    );
    await expect(
      verifyBundle({
        ...identity,
        directory: fixture.bundle,
        trustedPublicKey: fixture.publicKey,
        keyEnvironment: 'test',
        commit,
      }),
    ).rejects.toThrow('digest mismatch');
  });

  it('rejects a different trusted key and test/production confusion', async () => {
    const fixture = await createFixture();
    const other = await createFixture();
    await assemble(fixture.root, fixture.bundle);
    await signBundle({
      ...identity,
      directory: fixture.bundle,
      privateKey: fixture.privateKey,
      keyEnvironment: 'test',
      commit,
    });
    await expect(
      verifyBundle({
        ...identity,
        directory: fixture.bundle,
        trustedPublicKey: other.publicKey,
        keyEnvironment: 'test',
        commit,
      }),
    ).rejects.toThrow('untrusted signing key');
    await expect(
      verifyBundle({
        ...identity,
        directory: fixture.bundle,
        trustedPublicKey: fixture.publicKey,
        keyEnvironment: 'production',
        commit,
      }),
    ).rejects.toThrow('invalid signature record');
  });

  it('rejects an insecure private-key file and keys inside bundles', async () => {
    const fixture = await createFixture();
    await assemble(fixture.root, fixture.bundle);
    if (process.platform !== 'win32') {
      await chmod(fixture.privateKey, 0o644);
      await expect(
        signBundle({
          ...identity,
          directory: fixture.bundle,
          privateKey: fixture.privateKey,
          keyEnvironment: 'test',
          commit,
        }),
      ).rejects.toThrow('group or other');
      await chmod(fixture.privateKey, 0o600);
    }
    const embedded = resolve(fixture.bundle, 'embedded-key.pem');
    await cp(fixture.privateKey, embedded);
    await expect(
      signBundle({
        ...identity,
        directory: fixture.bundle,
        privateKey: embedded,
        keyEnvironment: 'test',
        commit,
      }),
    ).rejects.toThrow('outside');
  });

  it('rejects mismatched names, repository versions, and unsupported targets', async () => {
    const fixture = await createFixture();
    await expect(
      assembleBundle({
        ...identity,
        version: '0.2.0',
        directory: fixture.bundle,
        repositoryRoot: fixture.root,
        commit: '0123456789abcdef0123456789abcdef01234567',
        sourceDateEpoch: 1_753_158_400,
        builderId: 'urn:nexa:builder:test',
        invocationId: 'artifact-test-1',
      }),
    ).rejects.toThrow(ArtifactValidationError);
    await expect(
      assembleBundle({
        ...identity,
        platform: 'freebsd' as 'linux',
        directory: fixture.bundle,
        repositoryRoot: fixture.root,
        commit: '0123456789abcdef0123456789abcdef01234567',
        sourceDateEpoch: 1_753_158_400,
        builderId: 'urn:nexa:builder:test',
        invocationId: 'artifact-test-1',
      }),
    ).rejects.toThrow('unsupported platform');
  });
});
