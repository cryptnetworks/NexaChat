import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from './artifact-bundle.js';
import {
  loadUpdatePolicy,
  runLocalRecoveryMatrix,
  UpdateRecoveryError,
  UpdateRecoverySandbox,
  verifyUpdatePackage,
  type UpdatePolicy,
  type VerifiedUpdate,
} from './update-recovery.js';

const ROOT = resolve(import.meta.dirname, '../..');
const COMMIT = 'b1904f24f65d84ae1d589f5fb50b1a61be28f652';
const temporaryRoots: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function envelope(
  policy: UpdatePolicy,
  artifact: Buffer,
  privateKey: KeyObject,
  publicKey: KeyObject,
  overrides: {
    sourceVersion?: string;
    sourceChannel?: 'stable' | 'beta' | 'nightly';
    targetVersion?: string;
    targetChannel?: 'stable' | 'beta' | 'nightly';
  } = {},
) {
  const sourceVersion = overrides.sourceVersion ?? policy.targetVersion;
  const sourceChannel = overrides.sourceChannel ?? 'beta';
  const targetVersion = overrides.targetVersion ?? policy.targetVersion;
  const targetChannel = overrides.targetChannel ?? 'beta';
  const metadata = {
    schemaVersion: 1,
    updateId: 'unit-macos-arm64-update',
    product: 'nexa-chat',
    source: { version: sourceVersion, channel: sourceChannel, dataSchema: 1 },
    target: {
      version: targetVersion,
      channel: targetChannel,
      platform: 'macos',
      arch: 'arm64',
      dataSchema: 1,
      commit: COMMIT,
    },
    artifact: {
      name: `NexaChat-${targetVersion}-${targetChannel}-macos-arm64.dmg`,
      bytes: artifact.byteLength,
      sha256: sha256(artifact),
    },
    issuedAt: '2026-07-22T18:00:00.000Z',
  } as const;
  const bytes = canonicalJson(metadata);
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    metadata,
    signature: {
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyEnvironment: 'test',
      keyId: `sha256:${sha256(publicDer)}`,
      metadataSha256: sha256(bytes),
      signature: sign(null, Buffer.from(bytes), privateKey).toString('base64'),
    },
  } as const;
}

function verifyFixture(
  policy: UpdatePolicy,
  artifact: Buffer,
  signed: ReturnType<typeof envelope>,
  publicKey: KeyObject,
  keyEnvironment: 'test' | 'production' = 'test',
): VerifiedUpdate {
  return verifyUpdatePackage(
    policy,
    signed,
    artifact,
    publicKey.export({ type: 'spki', format: 'pem' }),
    {
      sourceVersion: signed.metadata.source.version,
      sourceChannel: signed.metadata.source.channel,
      targetVersion: signed.metadata.target.version,
      targetChannel: signed.metadata.target.channel,
      targetCommit: COMMIT,
      platform: 'macos',
      arch: 'arm64',
      keyEnvironment,
    },
  );
}

async function sandbox(policy: UpdatePolicy): Promise<UpdateRecoverySandbox> {
  const root = await mkdtemp(resolve(tmpdir(), 'nexa-update-unit-'));
  temporaryRoots.push(root);
  return UpdateRecoverySandbox.initialize(root, policy, {
    version: policy.targetVersion,
    channel: 'beta',
    artifact: Buffer.from('prior application'),
    data: 'original private local data',
    dataSchema: 1,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true })),
  );
});

describe('desktop update recovery policy', () => {
  it('matches the repository version and exact supported platform matrix', async () => {
    const policy = await loadUpdatePolicy(ROOT);
    expect(policy.targetVersion).toBe('0.1.0');
    expect(policy.platforms).toEqual([
      { platform: 'linux', arch: 'x64' },
      { platform: 'macos', arch: 'arm64' },
      { platform: 'macos', arch: 'x64' },
      { platform: 'windows', arch: 'x64' },
    ]);
    expect(policy.supportedPaths).toEqual([
      {
        sourceVersion: '0.1.0',
        targetVersion: '0.1.0',
        mode: 'same-version-recovery',
      },
    ]);
  });

  it('runs every signed test failure and rollback scenario with bounded evidence', async () => {
    const policy = await loadUpdatePolicy(ROOT);
    const evidence = await runLocalRecoveryMatrix(policy, COMMIT);
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      evidenceKind: 'signed-test-harness',
      version: '0.1.0',
      commit: COMMIT,
      keyEnvironment: 'test',
      passed: true,
    });
    expect(policy.platforms).toContainEqual({
      platform: evidence.platform,
      arch: evidence.arch,
    });
    expect(evidence.scenarios).toEqual(
      policy.requiredScenarios.map((id) => ({ id, status: 'passed' })),
    );
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(
      policy.evidence.maximumBytes,
    );
  });
});

describe('signed update envelope', () => {
  it('binds metadata, external trust, exact target identity, and artifact bytes', async () => {
    const policy = await loadUpdatePolicy(ROOT);
    const artifact = Buffer.from('signed update');
    const keys = generateKeyPairSync('ed25519');
    const signed = envelope(policy, artifact, keys.privateKey, keys.publicKey);
    const verified = verifyFixture(policy, artifact, signed, keys.publicKey);
    expect(verified).toMatchObject({
      keyEnvironment: 'test',
      metadataSha256: signed.signature.metadataSha256,
    });

    expect(() =>
      verifyFixture(policy, artifact, signed, keys.publicKey, 'production'),
    ).toThrow(new UpdateRecoveryError('invalid_signature'));
    const corrupted = Buffer.from(artifact);
    corrupted[0] = (corrupted[0] ?? 0) ^ 1;
    expect(() =>
      verifyFixture(policy, corrupted, signed, keys.publicKey),
    ).toThrow(new UpdateRecoveryError('artifact_integrity_failure'));
    const otherKey = generateKeyPairSync('ed25519').publicKey;
    expect(() => verifyFixture(policy, artifact, signed, otherKey)).toThrow(
      new UpdateRecoveryError('invalid_signature'),
    );
  });

  it('rejects signed downgrades even when a malformed caller policy lists one', async () => {
    const current = await loadUpdatePolicy(ROOT);
    const policy: UpdatePolicy = {
      ...current,
      supportedPaths: [
        {
          sourceVersion: '0.2.0',
          targetVersion: '0.1.0',
          mode: 'in-place-update',
        },
      ],
    };
    const artifact = Buffer.from('signed downgrade');
    const keys = generateKeyPairSync('ed25519');
    const signed = envelope(policy, artifact, keys.privateKey, keys.publicKey, {
      sourceVersion: '0.2.0',
      targetVersion: '0.1.0',
    });
    expect(() =>
      verifyFixture(policy, artifact, signed, keys.publicKey),
    ).toThrow(new UpdateRecoveryError('downgrade_rejected'));
  });

  it('rejects unknown metadata even when its known fields were signed', async () => {
    const policy = await loadUpdatePolicy(ROOT);
    const artifact = Buffer.from('signed update');
    const keys = generateKeyPairSync('ed25519');
    const signed = envelope(policy, artifact, keys.privateKey, keys.publicKey);
    const malformed = {
      ...signed,
      metadata: { ...signed.metadata, endpoint: 'https://untrusted.test' },
    };
    expect(() =>
      verifyFixture(policy, artifact, malformed, keys.publicKey),
    ).toThrow(new UpdateRecoveryError('invalid_update_metadata'));
  });
});

describe('dual-slot recovery sandbox', () => {
  it('recovers an interrupted inactive slot, retries, and deduplicates success', async () => {
    const policy = await loadUpdatePolicy(ROOT);
    const artifact = Buffer.from('signed update');
    const keys = generateKeyPairSync('ed25519');
    const verified = verifyFixture(
      policy,
      artifact,
      envelope(policy, artifact, keys.privateKey, keys.publicKey),
      keys.publicKey,
    );
    const installation = await sandbox(policy);
    const options = {
      availableBytes: 10_000,
      migrate: (data: string) =>
        Promise.resolve({ data: `${data}:new`, schema: 1 }),
      healthCheck: () => Promise.resolve(true),
    };
    await expect(
      installation.apply(verified, {
        ...options,
        fault: 'pre-activation-interruption',
      }),
    ).rejects.toThrow(new UpdateRecoveryError('installation_interrupted'));
    expect(await installation.recover()).toMatchObject({
      slotId: 'baseline',
      data: 'original private local data',
    });

    const activated = await installation.apply(verified, options);
    const duplicate = await installation.apply(verified, options);
    expect(duplicate).toEqual(activated);
    expect(activated.data).toBe('original private local data:new');

    expect(await installation.rollback()).toMatchObject({
      slotId: 'baseline',
      data: 'original private local data',
    });
  });

  it('keeps the prior data copy authoritative when migration or health fails', async () => {
    const policy = await loadUpdatePolicy(ROOT);
    const artifact = Buffer.from('signed update');
    const keys = generateKeyPairSync('ed25519');
    const verified = verifyFixture(
      policy,
      artifact,
      envelope(policy, artifact, keys.privateKey, keys.publicKey),
      keys.publicKey,
    );
    const migrationFailure = await sandbox(policy);
    await expect(
      migrationFailure.apply(verified, {
        availableBytes: 10_000,
        migrate: () => Promise.reject(new Error('private migration detail')),
        healthCheck: () => Promise.resolve(true),
      }),
    ).rejects.toThrow(new UpdateRecoveryError('migration_failed'));
    expect((await migrationFailure.recover()).data).toBe(
      'original private local data',
    );

    const healthFailure = await sandbox(policy);
    await expect(
      healthFailure.apply(verified, {
        availableBytes: 10_000,
        migrate: (data) => Promise.resolve({ data: `${data}:new`, schema: 1 }),
        healthCheck: () => Promise.resolve(false),
      }),
    ).rejects.toThrow(new UpdateRecoveryError('startup_health_failed'));
    expect(await healthFailure.recover()).toMatchObject({
      slotId: 'baseline',
      data: 'original private local data',
    });
  });
});
