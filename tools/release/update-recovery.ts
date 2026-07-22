import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { arch as hostArch, platform as hostPlatform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { canonicalJson } from './artifact-bundle.js';
import { compareSemanticVersions, parseSemanticVersion } from './versioning.js';

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const POLICY_PATH = 'release/update-policy.json';
const CHANNELS = ['stable', 'beta', 'nightly'] as const;
const PLATFORMS = ['linux', 'macos', 'windows'] as const;
const ARCHITECTURES = ['arm64', 'x64'] as const;
const PATH_MODES = ['same-version-recovery', 'in-place-update'] as const;
const REQUIRED_SCENARIOS = [
  'artifact-corruption',
  'download-interruption',
  'insufficient-space',
  'invalid-signature',
  'migration-failure',
  'permission-failure',
  'post-activation-health-failure',
  'pre-activation-interruption',
  'release-channel-separation',
  'successful-activation-and-rollback',
] as const;
const REQUIRED_TARGETS = [
  { platform: 'linux', arch: 'x64' },
  { platform: 'macos', arch: 'arm64' },
  { platform: 'macos', arch: 'x64' },
  { platform: 'windows', arch: 'x64' },
] as const;
const ARTIFACT_FORMATS = {
  linux: ['AppImage', 'deb'],
  macos: ['dmg', 'app.tar.gz'],
  windows: ['msi', 'nsis.zip'],
} as const;

type JsonObject = Record<string, unknown>;
type Channel = (typeof CHANNELS)[number];
type Platform = (typeof PLATFORMS)[number];
type Architecture = (typeof ARCHITECTURES)[number];
type PathMode = (typeof PATH_MODES)[number];
type RequiredScenario = (typeof REQUIRED_SCENARIOS)[number];

interface TargetIdentity {
  platform: Platform;
  arch: Architecture;
}

interface SupportedPath {
  sourceVersion: string;
  targetVersion: string;
  mode: PathMode;
}

export interface UpdatePolicy {
  schemaVersion: 1;
  product: 'nexa-chat';
  targetVersion: string;
  supportedPaths: SupportedPath[];
  channels: Record<Channel, Channel[]>;
  platforms: TargetIdentity[];
  maximumMetadataBytes: number;
  maximumArtifactBytes: number;
  minimumFreeSpaceMultiplier: number;
  installation: {
    strategy: 'dual-slot-pointer';
    dataMigration: 'copy-on-write';
    automaticRollbackOnUnhealthy: true;
    retainedHealthySlots: 2;
  };
  requiredScenarios: RequiredScenario[];
  evidence: { maximumBytes: number; retentionDays: number };
}

interface UpdateMetadata {
  schemaVersion: 1;
  updateId: string;
  product: 'nexa-chat';
  source: { version: string; channel: Channel; dataSchema: number };
  target: {
    version: string;
    channel: Channel;
    platform: Platform;
    arch: Architecture;
    dataSchema: number;
    commit: string;
  };
  artifact: { name: string; bytes: number; sha256: string };
  issuedAt: string;
}

interface UpdateSignature {
  schemaVersion: 1;
  algorithm: 'Ed25519';
  keyEnvironment: 'test' | 'production';
  keyId: string;
  metadataSha256: string;
  signature: string;
}

export interface VerifiedUpdate {
  metadata: UpdateMetadata;
  metadataSha256: string;
  keyId: string;
  keyEnvironment: 'test' | 'production';
  artifact: Buffer;
}

interface VerificationExpectation extends TargetIdentity {
  sourceVersion: string;
  sourceChannel: Channel;
  targetVersion: string;
  targetChannel: Channel;
  targetCommit: string;
  keyEnvironment: 'test' | 'production';
}

interface SlotRecord {
  schemaVersion: 1;
  slotId: string;
  version: string;
  channel: Channel;
  artifactSha256: string;
  dataSchema: number;
  dataSha256: string;
  healthy: boolean;
}

interface PointerRecord {
  schemaVersion: 1;
  generation: number;
  slotId: string;
  checksum: string;
}

interface ActiveInstall extends SlotRecord {
  data: string;
  pointer: 'a' | 'b';
  generation: number;
}

type InstallFault =
  | 'migration-failure'
  | 'permission-failure'
  | 'post-activation-health-failure'
  | 'pre-activation-interruption'
  | 'staging-interruption';

interface ApplyOptions {
  availableBytes: number;
  fault?: InstallFault;
  migrate: (
    data: string,
    sourceSchema: number,
  ) => Promise<{ data: string; schema: number }>;
  healthCheck: () => Promise<boolean>;
}

export interface RecoveryEvidence {
  schemaVersion: 1;
  evidenceKind: 'signed-test-harness';
  version: string;
  commit: string;
  platform: Platform;
  arch: Architecture;
  keyEnvironment: 'test';
  keyId: string;
  metadataSha256: string;
  artifactSha256: string;
  startedAt: string;
  completedAt: string;
  scenarios: Array<{ id: RequiredScenario; status: 'passed' | 'failed' }>;
  passed: boolean;
}

export class UpdateRecoveryError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'UpdateRecoveryError';
  }
}

function fail(code: string): never {
  throw new UpdateRecoveryError(code);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonObject, keys: string[], context: string): void {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...keys].sort())
  ) {
    fail(`invalid_${context}`);
  }
}

function boundedText(value: unknown, maximum: number, context: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\r\n\0]/.test(value)
  ) {
    fail(`invalid_${context}`);
  }
  return value;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  context: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    fail(`invalid_${context}`);
  }
  return Number(value);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  context: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`invalid_${context}`);
  }
  return value as T;
}

function sha256(value: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function digest(value: unknown, context: string): string {
  const parsed = boundedText(value, 64, context);
  if (!/^[0-9a-f]{64}$/.test(parsed)) fail(`invalid_${context}`);
  return parsed;
}

function fullCommit(value: unknown, context: string): string {
  const parsed = boundedText(value, 64, context);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parsed)) {
    fail(`invalid_${context}`);
  }
  return parsed;
}

function semanticVersion(value: unknown, context: string): string {
  const parsed = boundedText(value, 64, context);
  try {
    parseSemanticVersion(parsed);
  } catch {
    fail(`invalid_${context}`);
  }
  return parsed;
}

function timestamp(value: unknown, context: string): string {
  const parsed = boundedText(value, 40, context);
  try {
    if (new Date(parsed).toISOString() !== parsed) fail(`invalid_${context}`);
  } catch {
    fail(`invalid_${context}`);
  }
  return parsed;
}

function targetKey(target: TargetIdentity): string {
  return `${target.platform}/${target.arch}`;
}

function safeId(value: unknown, context: string): string {
  const parsed = boundedText(value, 80, context);
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,78}[a-z0-9])?$/.test(parsed)) {
    fail(`invalid_${context}`);
  }
  return parsed;
}

async function readBoundedJson(
  path: string,
  maximumBytes: number,
  context: string,
): Promise<JsonObject> {
  let details;
  try {
    details = await lstat(path);
  } catch {
    return fail(`missing_${context}`);
  }
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size <= 0 ||
    details.size > maximumBytes
  ) {
    fail(`invalid_${context}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fail(`invalid_${context}`);
  }
  if (!isObject(parsed)) fail(`invalid_${context}`);
  return parsed;
}

function parseSupportedPaths(value: unknown): SupportedPath[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    fail('invalid_supported_paths');
  }
  const paths = value.map((entry) => {
    if (!isObject(entry)) return fail('invalid_supported_path');
    exactKeys(
      entry,
      ['sourceVersion', 'targetVersion', 'mode'],
      'supported_path',
    );
    const sourceVersion = semanticVersion(
      entry.sourceVersion,
      'source_version',
    );
    const targetVersion = semanticVersion(
      entry.targetVersion,
      'target_version',
    );
    const mode = oneOf(entry.mode, PATH_MODES, 'path_mode');
    const comparison = compareSemanticVersions(targetVersion, sourceVersion);
    if (
      (mode === 'same-version-recovery' && comparison !== 0) ||
      (mode === 'in-place-update' && comparison <= 0)
    ) {
      fail('invalid_supported_path_direction');
    }
    return { sourceVersion, targetVersion, mode };
  });
  const identities = paths.map(
    (path) => `${path.sourceVersion}:${path.targetVersion}:${path.mode}`,
  );
  if (
    new Set(identities).size !== identities.length ||
    JSON.stringify(identities) !== JSON.stringify([...identities].sort())
  ) {
    fail('invalid_supported_path_order');
  }
  return paths;
}

function parsePolicy(value: JsonObject): UpdatePolicy {
  exactKeys(
    value,
    [
      'schemaVersion',
      'product',
      'targetVersion',
      'supportedPaths',
      'channels',
      'platforms',
      'maximumMetadataBytes',
      'maximumArtifactBytes',
      'minimumFreeSpaceMultiplier',
      'installation',
      'requiredScenarios',
      'evidence',
    ],
    'update_policy',
  );
  if (value.schemaVersion !== 1 || value.product !== 'nexa-chat') {
    fail('unsupported_update_policy');
  }
  const targetVersion = semanticVersion(value.targetVersion, 'target_version');
  const supportedPaths = parseSupportedPaths(value.supportedPaths);
  if (!isObject(value.channels)) fail('invalid_channel_policy');
  const channelPolicy = value.channels;
  exactKeys(channelPolicy, [...CHANNELS], 'channel_policy');
  const channels = Object.fromEntries(
    CHANNELS.map((target) => {
      const entries = channelPolicy[target];
      if (
        !Array.isArray(entries) ||
        entries.length === 0 ||
        entries.some((entry) => typeof entry !== 'string')
      ) {
        fail('invalid_channel_path');
      }
      const parsed = entries.map((entry) =>
        oneOf(entry, CHANNELS, 'source_channel'),
      );
      if (new Set(parsed).size !== parsed.length)
        fail('duplicate_channel_path');
      return [target, parsed];
    }),
  ) as Record<Channel, Channel[]>;
  if (!Array.isArray(value.platforms) || value.platforms.length !== 4) {
    fail('invalid_update_platforms');
  }
  const platforms = value.platforms.map((entry) => {
    if (!isObject(entry)) return fail('invalid_update_platform');
    exactKeys(entry, ['platform', 'arch'], 'update_platform');
    return {
      platform: oneOf(entry.platform, PLATFORMS, 'platform'),
      arch: oneOf(entry.arch, ARCHITECTURES, 'architecture'),
    };
  });
  if (
    JSON.stringify(platforms) !== JSON.stringify(REQUIRED_TARGETS) ||
    new Set(platforms.map(targetKey)).size !== platforms.length
  ) {
    fail('incomplete_update_platforms');
  }
  if (!isObject(value.installation)) fail('invalid_installation_policy');
  exactKeys(
    value.installation,
    [
      'strategy',
      'dataMigration',
      'automaticRollbackOnUnhealthy',
      'retainedHealthySlots',
    ],
    'installation_policy',
  );
  if (
    value.installation.strategy !== 'dual-slot-pointer' ||
    value.installation.dataMigration !== 'copy-on-write' ||
    value.installation.automaticRollbackOnUnhealthy !== true ||
    value.installation.retainedHealthySlots !== 2
  ) {
    fail('unsafe_installation_policy');
  }
  if (
    !Array.isArray(value.requiredScenarios) ||
    JSON.stringify(value.requiredScenarios) !==
      JSON.stringify(REQUIRED_SCENARIOS)
  ) {
    fail('incomplete_recovery_scenarios');
  }
  if (!isObject(value.evidence)) fail('invalid_evidence_policy');
  exactKeys(
    value.evidence,
    ['maximumBytes', 'retentionDays'],
    'evidence_policy',
  );
  return {
    schemaVersion: 1,
    product: 'nexa-chat',
    targetVersion,
    supportedPaths,
    channels,
    platforms,
    maximumMetadataBytes: integer(
      value.maximumMetadataBytes,
      1024,
      65_536,
      'maximum_metadata_bytes',
    ),
    maximumArtifactBytes: integer(
      value.maximumArtifactBytes,
      1_048_576,
      4_294_967_296,
      'maximum_artifact_bytes',
    ),
    minimumFreeSpaceMultiplier: integer(
      value.minimumFreeSpaceMultiplier,
      2,
      8,
      'free_space_multiplier',
    ),
    installation: {
      strategy: 'dual-slot-pointer',
      dataMigration: 'copy-on-write',
      automaticRollbackOnUnhealthy: true,
      retainedHealthySlots: 2,
    },
    requiredScenarios: [...REQUIRED_SCENARIOS],
    evidence: {
      maximumBytes: integer(
        value.evidence.maximumBytes,
        4096,
        65_536,
        'maximum_evidence_bytes',
      ),
      retentionDays: integer(
        value.evidence.retentionDays,
        180,
        3650,
        'evidence_retention',
      ),
    },
  };
}

export async function loadUpdatePolicy(
  root = REPOSITORY_ROOT,
): Promise<UpdatePolicy> {
  const policy = parsePolicy(
    await readBoundedJson(resolve(root, POLICY_PATH), 65_536, 'update_policy'),
  );
  const manifest = await readBoundedJson(
    resolve(root, 'package.json'),
    1_048_576,
    'root_manifest',
  );
  const upgrade = await readBoundedJson(
    resolve(root, 'release/upgrade-policy.json'),
    65_536,
    'upgrade_policy',
  );
  const upgradeSourceVersions = Array.isArray(upgrade.supportedSourceVersions)
    ? upgrade.supportedSourceVersions.map((version) =>
        semanticVersion(version, 'upgrade_source_version'),
      )
    : fail('invalid_upgrade_source_versions');
  if (
    manifest.version !== policy.targetVersion ||
    upgrade.targetVersion !== policy.targetVersion ||
    JSON.stringify(upgrade.channels) !== JSON.stringify(policy.channels) ||
    policy.supportedPaths.some(
      (path) => !upgradeSourceVersions.includes(path.sourceVersion),
    ) ||
    policy.supportedPaths.some(
      (path) => path.targetVersion !== policy.targetVersion,
    )
  ) {
    fail('update_version_drift');
  }
  return policy;
}

function parseMetadata(value: unknown, maximumBytes: number): UpdateMetadata {
  if (!isObject(value)) fail('invalid_update_metadata');
  if (Buffer.byteLength(canonicalJson(value)) > maximumBytes) {
    fail('update_metadata_too_large');
  }
  exactKeys(
    value,
    [
      'schemaVersion',
      'updateId',
      'product',
      'source',
      'target',
      'artifact',
      'issuedAt',
    ],
    'update_metadata',
  );
  if (value.schemaVersion !== 1 || value.product !== 'nexa-chat') {
    fail('unsupported_update_metadata');
  }
  if (!isObject(value.source)) fail('invalid_update_source');
  exactKeys(
    value.source,
    ['version', 'channel', 'dataSchema'],
    'update_source',
  );
  if (!isObject(value.target)) fail('invalid_update_target');
  exactKeys(
    value.target,
    ['version', 'channel', 'platform', 'arch', 'dataSchema', 'commit'],
    'update_target',
  );
  if (!isObject(value.artifact)) fail('invalid_update_artifact');
  exactKeys(value.artifact, ['name', 'bytes', 'sha256'], 'update_artifact');
  return {
    schemaVersion: 1,
    updateId: safeId(value.updateId, 'update_id'),
    product: 'nexa-chat',
    source: {
      version: semanticVersion(value.source.version, 'source_version'),
      channel: oneOf(value.source.channel, CHANNELS, 'source_channel'),
      dataSchema: integer(
        value.source.dataSchema,
        0,
        1_000_000,
        'source_schema',
      ),
    },
    target: {
      version: semanticVersion(value.target.version, 'target_version'),
      channel: oneOf(value.target.channel, CHANNELS, 'target_channel'),
      platform: oneOf(value.target.platform, PLATFORMS, 'target_platform'),
      arch: oneOf(value.target.arch, ARCHITECTURES, 'target_architecture'),
      dataSchema: integer(
        value.target.dataSchema,
        0,
        1_000_000,
        'target_schema',
      ),
      commit: fullCommit(value.target.commit, 'target_commit'),
    },
    artifact: {
      name: boundedText(value.artifact.name, 180, 'artifact_name'),
      bytes: integer(value.artifact.bytes, 1, 4_294_967_296, 'artifact_bytes'),
      sha256: digest(value.artifact.sha256, 'artifact_digest'),
    },
    issuedAt: timestamp(value.issuedAt, 'metadata_time'),
  };
}

function parseSignature(value: unknown): UpdateSignature {
  if (!isObject(value)) fail('invalid_update_signature');
  exactKeys(
    value,
    [
      'schemaVersion',
      'algorithm',
      'keyEnvironment',
      'keyId',
      'metadataSha256',
      'signature',
    ],
    'update_signature',
  );
  if (value.schemaVersion !== 1 || value.algorithm !== 'Ed25519') {
    fail('unsupported_update_signature');
  }
  const signature = boundedText(value.signature, 88, 'signature_value');
  const signatureBytes = Buffer.from(signature, 'base64');
  if (
    signatureBytes.length !== 64 ||
    signatureBytes.toString('base64') !== signature
  ) {
    fail('invalid_signature_encoding');
  }
  const keyId = boundedText(value.keyId, 71, 'key_id');
  if (!/^sha256:[0-9a-f]{64}$/.test(keyId)) fail('invalid_key_id');
  return {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyEnvironment: oneOf(
      value.keyEnvironment,
      ['test', 'production'] as const,
      'key_environment',
    ),
    keyId,
    metadataSha256: digest(value.metadataSha256, 'metadata_digest'),
    signature,
  };
}

function publicKey(value: string | Buffer): { key: KeyObject; id: string } {
  if (Buffer.byteLength(value) === 0 || Buffer.byteLength(value) > 16_384) {
    fail('invalid_trusted_public_key');
  }
  let key: KeyObject;
  try {
    key = createPublicKey(value);
  } catch {
    return fail('invalid_trusted_public_key');
  }
  if (key.asymmetricKeyType !== 'ed25519') fail('invalid_trusted_public_key');
  const der = key.export({ type: 'spki', format: 'der' });
  return { key, id: `sha256:${sha256(der)}` };
}

function validArtifactName(metadata: UpdateMetadata): boolean {
  const stem = `NexaChat-${metadata.target.version}-${metadata.target.channel}-${metadata.target.platform}-${metadata.target.arch}`;
  return ARTIFACT_FORMATS[metadata.target.platform].some(
    (format) => metadata.artifact.name === `${stem}.${format}`,
  );
}

export function verifyUpdatePackage(
  policy: UpdatePolicy,
  envelope: unknown,
  artifact: Uint8Array,
  trustedPublicKey: string | Buffer,
  expected: VerificationExpectation,
): VerifiedUpdate {
  if (!isObject(envelope)) fail('invalid_update_envelope');
  exactKeys(envelope, ['metadata', 'signature'], 'update_envelope');
  const metadata = parseMetadata(
    envelope.metadata,
    policy.maximumMetadataBytes,
  );
  const signature = parseSignature(envelope.signature);
  const metadataBytes = canonicalJson(metadata);
  const metadataSha256 = sha256(metadataBytes);
  const trusted = publicKey(trustedPublicKey);
  if (
    signature.metadataSha256 !== metadataSha256 ||
    signature.keyId !== trusted.id ||
    signature.keyEnvironment !== expected.keyEnvironment ||
    !verifySignature(
      null,
      Buffer.from(metadataBytes),
      trusted.key,
      Buffer.from(signature.signature, 'base64'),
    )
  ) {
    fail('invalid_signature');
  }
  if (
    metadata.source.version !== expected.sourceVersion ||
    metadata.source.channel !== expected.sourceChannel ||
    metadata.target.version !== expected.targetVersion ||
    metadata.target.channel !== expected.targetChannel ||
    metadata.target.platform !== expected.platform ||
    metadata.target.arch !== expected.arch ||
    metadata.target.commit !== expected.targetCommit
  ) {
    fail('unexpected_update_identity');
  }
  if (
    !policy.platforms.some(
      (target) => targetKey(target) === targetKey(metadata.target),
    )
  ) {
    fail('unsupported_update_platform');
  }
  const path = policy.supportedPaths.find(
    (candidate) =>
      candidate.sourceVersion === metadata.source.version &&
      candidate.targetVersion === metadata.target.version,
  );
  if (!path) fail('unsupported_update_path');
  const comparison = compareSemanticVersions(
    metadata.target.version,
    metadata.source.version,
  );
  if (comparison < 0) fail('downgrade_rejected');
  if (
    (comparison === 0 && path.mode !== 'same-version-recovery') ||
    (comparison > 0 && path.mode !== 'in-place-update')
  ) {
    fail('update_mode_mismatch');
  }
  if (
    !policy.channels[metadata.target.channel].includes(metadata.source.channel)
  ) {
    fail('channel_path_unsupported');
  }
  if (!validArtifactName(metadata)) fail('invalid_artifact_name');
  if (
    metadata.artifact.bytes > policy.maximumArtifactBytes ||
    artifact.byteLength !== metadata.artifact.bytes
  ) {
    fail('artifact_size_mismatch');
  }
  const artifactBuffer = Buffer.from(artifact);
  if (sha256(artifactBuffer) !== metadata.artifact.sha256) {
    fail('artifact_integrity_failure');
  }
  return {
    metadata,
    metadataSha256,
    keyId: trusted.id,
    keyEnvironment: signature.keyEnvironment,
    artifact: artifactBuffer,
  };
}

function pointerChecksum(generation: number, slotId: string): string {
  return sha256(canonicalJson({ generation, schemaVersion: 1, slotId }));
}

function parseSlot(value: JsonObject): SlotRecord {
  exactKeys(
    value,
    [
      'schemaVersion',
      'slotId',
      'version',
      'channel',
      'artifactSha256',
      'dataSchema',
      'dataSha256',
      'healthy',
    ],
    'slot_record',
  );
  if (value.schemaVersion !== 1 || typeof value.healthy !== 'boolean') {
    fail('invalid_slot_record');
  }
  return {
    schemaVersion: 1,
    slotId: safeId(value.slotId, 'slot_id'),
    version: semanticVersion(value.version, 'slot_version'),
    channel: oneOf(value.channel, CHANNELS, 'slot_channel'),
    artifactSha256: digest(value.artifactSha256, 'slot_artifact_digest'),
    dataSchema: integer(value.dataSchema, 0, 1_000_000, 'slot_data_schema'),
    dataSha256: digest(value.dataSha256, 'slot_data_digest'),
    healthy: value.healthy,
  };
}

function parsePointer(value: JsonObject): PointerRecord {
  exactKeys(
    value,
    ['schemaVersion', 'generation', 'slotId', 'checksum'],
    'pointer_record',
  );
  if (value.schemaVersion !== 1) fail('invalid_pointer_record');
  const generation = integer(value.generation, 1, 1_000_000, 'generation');
  const slotId = safeId(value.slotId, 'slot_id');
  const checksum = digest(value.checksum, 'pointer_checksum');
  if (checksum !== pointerChecksum(generation, slotId)) {
    fail('invalid_pointer_checksum');
  }
  return { schemaVersion: 1, generation, slotId, checksum };
}

async function writeCanonical(
  path: string,
  value: unknown,
  exclusive = true,
): Promise<void> {
  await writeFile(path, `${canonicalJson(value)}\n`, {
    encoding: 'utf8',
    ...(exclusive ? { flag: 'wx' as const } : {}),
    mode: 0o600,
  });
}

async function replaceCanonical(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeCanonical(temporary, value);
    try {
      await unlink(path);
    } catch (error) {
      if (!isObject(error) || error.code !== 'ENOENT') throw error;
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export class UpdateRecoverySandbox {
  private readonly slotsPath: string;
  private readonly stagingPath: string;
  private readonly pointersPath: string;

  private constructor(
    private readonly root: string,
    private readonly policy: UpdatePolicy,
  ) {
    this.slotsPath = resolve(root, 'slots');
    this.stagingPath = resolve(root, 'staging');
    this.pointersPath = resolve(root, 'pointers');
  }

  static async initialize(
    root: string,
    policy: UpdatePolicy,
    baseline: {
      version: string;
      channel: Channel;
      artifact: Buffer;
      data: string;
      dataSchema: number;
    },
  ): Promise<UpdateRecoverySandbox> {
    const rootDetails = await lstat(root);
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
      fail('invalid_sandbox_root');
    }
    if (Buffer.byteLength(baseline.data) > 1_048_576)
      fail('local_data_too_large');
    semanticVersion(baseline.version, 'baseline_version');
    integer(baseline.dataSchema, 0, 1_000_000, 'baseline_schema');
    const sandbox = new UpdateRecoverySandbox(root, policy);
    await Promise.all([
      mkdir(sandbox.slotsPath),
      mkdir(sandbox.stagingPath),
      mkdir(sandbox.pointersPath),
    ]);
    const slotId = 'baseline';
    const slotPath = resolve(sandbox.slotsPath, slotId);
    await mkdir(slotPath);
    await writeFile(resolve(slotPath, 'app.bin'), baseline.artifact, {
      flag: 'wx',
      mode: 0o700,
    });
    await writeFile(resolve(slotPath, 'data.bin'), baseline.data, {
      flag: 'wx',
      mode: 0o600,
    });
    const slot: SlotRecord = {
      schemaVersion: 1,
      slotId,
      version: baseline.version,
      channel: baseline.channel,
      artifactSha256: sha256(baseline.artifact),
      dataSchema: baseline.dataSchema,
      dataSha256: sha256(baseline.data),
      healthy: true,
    };
    await writeCanonical(resolve(slotPath, 'state.json'), slot);
    const pointer: PointerRecord = {
      schemaVersion: 1,
      generation: 1,
      slotId,
      checksum: pointerChecksum(1, slotId),
    };
    await writeCanonical(resolve(sandbox.pointersPath, 'a.json'), pointer);
    return sandbox;
  }

  private async readSlot(
    slotId: string,
  ): Promise<SlotRecord & { data: string }> {
    const slotPath = resolve(this.slotsPath, safeId(slotId, 'slot_id'));
    const record = parseSlot(
      await readBoundedJson(
        resolve(slotPath, 'state.json'),
        16_384,
        'slot_state',
      ),
    );
    if (record.slotId !== slotId) fail('slot_identity_mismatch');
    const [artifact, data] = await Promise.all([
      readFile(resolve(slotPath, 'app.bin')),
      readFile(resolve(slotPath, 'data.bin'), 'utf8'),
    ]);
    if (
      artifact.byteLength > this.policy.maximumArtifactBytes ||
      Buffer.byteLength(data) > 1_048_576 ||
      sha256(artifact) !== record.artifactSha256 ||
      sha256(data) !== record.dataSha256
    ) {
      fail('slot_integrity_failure');
    }
    return { ...record, data };
  }

  private async validPointers(): Promise<
    Array<{
      name: 'a' | 'b';
      pointer: PointerRecord;
      slot: SlotRecord & { data: string };
    }>
  > {
    const results = [];
    for (const name of ['a', 'b'] as const) {
      try {
        const pointer = parsePointer(
          await readBoundedJson(
            resolve(this.pointersPath, `${name}.json`),
            4096,
            'install_pointer',
          ),
        );
        const slot = await this.readSlot(pointer.slotId);
        if (slot.healthy) results.push({ name, pointer, slot });
      } catch {
        // Invalid or incomplete generations are ignored in favor of a healthy slot.
      }
    }
    return results.sort(
      (left, right) => right.pointer.generation - left.pointer.generation,
    );
  }

  async active(): Promise<ActiveInstall> {
    const selected = (await this.validPointers())[0];
    if (!selected) fail('no_healthy_installation');
    return {
      ...selected.slot,
      pointer: selected.name,
      generation: selected.pointer.generation,
    };
  }

  async apply(
    update: VerifiedUpdate,
    options: ApplyOptions,
  ): Promise<ActiveInstall> {
    const current = await this.active();
    if (current.slotId === update.metadata.updateId) {
      if (
        current.version === update.metadata.target.version &&
        current.channel === update.metadata.target.channel &&
        current.artifactSha256 === update.metadata.artifact.sha256 &&
        current.dataSchema === update.metadata.target.dataSchema
      ) {
        return current;
      }
      fail('update_id_conflict');
    }
    if (
      current.version !== update.metadata.source.version ||
      current.channel !== update.metadata.source.channel ||
      current.dataSchema !== update.metadata.source.dataSchema
    ) {
      fail('installed_source_mismatch');
    }
    const dataBytes = Buffer.byteLength(current.data);
    const requiredBytes =
      (update.artifact.byteLength + dataBytes) *
      this.policy.minimumFreeSpaceMultiplier;
    if (
      !Number.isSafeInteger(options.availableBytes) ||
      options.availableBytes < requiredBytes
    ) {
      fail('insufficient_space');
    }
    if (options.fault === 'permission-failure') fail('permission_denied');
    const slotId = update.metadata.updateId;
    const staging = resolve(this.stagingPath, slotId);
    const finalSlot = resolve(this.slotsPath, slotId);
    try {
      await mkdir(staging);
      await writeFile(resolve(staging, 'app.bin'), update.artifact, {
        flag: 'wx',
        mode: 0o700,
      });
      if (options.fault === 'staging-interruption') {
        fail('installation_interrupted');
      }
      if (options.fault === 'migration-failure') fail('migration_failed');
      let migrated: { data: string; schema: number };
      try {
        migrated = await options.migrate(current.data, current.dataSchema);
      } catch {
        return fail('migration_failed');
      }
      if (
        migrated.schema !== update.metadata.target.dataSchema ||
        Buffer.byteLength(migrated.data) > 1_048_576
      ) {
        fail('migration_result_invalid');
      }
      await writeFile(resolve(staging, 'data.bin'), migrated.data, {
        flag: 'wx',
        mode: 0o600,
      });
      const slot: SlotRecord = {
        schemaVersion: 1,
        slotId,
        version: update.metadata.target.version,
        channel: update.metadata.target.channel,
        artifactSha256: update.metadata.artifact.sha256,
        dataSchema: migrated.schema,
        dataSha256: sha256(migrated.data),
        healthy: false,
      };
      await writeCanonical(resolve(staging, 'state.json'), slot);
      await rename(staging, finalSlot);
      if (options.fault === 'pre-activation-interruption') {
        fail('installation_interrupted');
      }
      const pointerName = current.pointer === 'a' ? 'b' : 'a';
      const generation = current.generation + 1;
      const pointer: PointerRecord = {
        schemaVersion: 1,
        generation,
        slotId,
        checksum: pointerChecksum(generation, slotId),
      };
      await replaceCanonical(
        resolve(this.pointersPath, `${pointerName}.json`),
        pointer,
      );
      if (options.fault === 'post-activation-health-failure') {
        fail('startup_health_failed');
      }
      let healthy = false;
      try {
        healthy = await options.healthCheck();
      } catch {
        healthy = false;
      }
      if (!healthy) fail('startup_health_failed');
      await replaceCanonical(resolve(finalSlot, 'state.json'), {
        ...slot,
        healthy: true,
      });
      return await this.active();
    } catch (error) {
      if (error instanceof UpdateRecoveryError) throw error;
      return fail('installation_failed');
    }
  }

  async recover(): Promise<ActiveInstall> {
    await this.active();
    let entries: string[];
    try {
      entries = await readdir(this.stagingPath);
    } catch {
      return fail('recovery_failed');
    }
    if (entries.length > 16) fail('recovery_work_bounded');
    for (const entry of entries) {
      safeId(entry, 'staging_entry');
      const path = resolve(this.stagingPath, entry);
      const details = await lstat(path);
      if (details.isSymbolicLink()) await unlink(path);
      else if (details.isDirectory()) await rm(path, { recursive: true });
      else await unlink(path);
    }
    const referencedSlots = new Set(
      (await this.validPointers()).map((entry) => entry.pointer.slotId),
    );
    const slots = await readdir(this.slotsPath);
    if (slots.length > 16) fail('recovery_work_bounded');
    for (const slot of slots) {
      safeId(slot, 'slot_id');
      if (referencedSlots.has(slot)) continue;
      const path = resolve(this.slotsPath, slot);
      const details = await lstat(path);
      if (details.isSymbolicLink()) await unlink(path);
      else if (details.isDirectory()) await rm(path, { recursive: true });
      else await unlink(path);
    }
    return this.active();
  }

  async rollback(): Promise<ActiveInstall> {
    const pointers = await this.validPointers();
    const current = pointers[0];
    const previous = pointers.find(
      (candidate) => candidate.pointer.slotId !== current?.pointer.slotId,
    );
    if (!current || !previous) fail('rollback_unavailable');
    const supported = this.policy.supportedPaths.some(
      (path) =>
        path.sourceVersion === previous.slot.version &&
        path.targetVersion === current.slot.version,
    );
    if (!supported) fail('rollback_unsupported');
    const pointerName = current.name === 'a' ? 'b' : 'a';
    const generation = current.pointer.generation + 1;
    const pointer: PointerRecord = {
      schemaVersion: 1,
      generation,
      slotId: previous.slot.slotId,
      checksum: pointerChecksum(generation, previous.slot.slotId),
    };
    await replaceCanonical(
      resolve(this.pointersPath, `${pointerName}.json`),
      pointer,
    );
    return this.active();
  }
}

function hostTarget(policy: UpdatePolicy): TargetIdentity {
  const platformByHost: Partial<Record<NodeJS.Platform, Platform>> = {
    darwin: 'macos',
    linux: 'linux',
    win32: 'windows',
  };
  const architectureByHost: Partial<Record<NodeJS.Architecture, Architecture>> =
    {
      arm64: 'arm64',
      x64: 'x64',
    };
  const platform = platformByHost[hostPlatform()];
  const arch = architectureByHost[hostArch()];
  if (!platform || !arch) fail('unsupported_test_host');
  const target = { platform, arch };
  if (
    !policy.platforms.some((entry) => targetKey(entry) === targetKey(target))
  ) {
    fail('unsupported_test_host');
  }
  return target;
}

function artifactExtension(platform: Platform): string {
  return { linux: 'AppImage', macos: 'dmg', windows: 'msi' }[platform];
}

function signedEnvelope(
  metadata: UpdateMetadata,
  privateKey: KeyObject,
  publicKeyValue: KeyObject,
): { metadata: UpdateMetadata; signature: UpdateSignature } {
  const metadataBytes = canonicalJson(metadata);
  const publicDer = publicKeyValue.export({ type: 'spki', format: 'der' });
  return {
    metadata,
    signature: {
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyEnvironment: 'test',
      keyId: `sha256:${sha256(publicDer)}`,
      metadataSha256: sha256(metadataBytes),
      signature: sign(null, Buffer.from(metadataBytes), privateKey).toString(
        'base64',
      ),
    },
  };
}

function expectedFailure(work: () => unknown, code: string): void {
  try {
    work();
  } catch (error) {
    if (error instanceof UpdateRecoveryError && error.code === code) return;
    return fail('unexpected_scenario_failure');
  }
  fail('scenario_did_not_fail');
}

async function expectedAsyncFailure(
  work: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (error instanceof UpdateRecoveryError && error.code === code) return;
    return fail('unexpected_scenario_failure');
  }
  fail('scenario_did_not_fail');
}

export async function runLocalRecoveryMatrix(
  policy: UpdatePolicy,
  commit: string,
): Promise<RecoveryEvidence> {
  const target = hostTarget(policy);
  const checkedCommit = fullCommit(commit, 'expected_commit');
  const startedAt = new Date().toISOString();
  const artifact = Buffer.from(
    'Nexa Chat signed update recovery test artifact\n',
  );
  const { privateKey, publicKey: testPublicKey } =
    generateKeyPairSync('ed25519');
  const publicPem = testPublicKey.export({ type: 'spki', format: 'pem' });
  const updateId = `recovery-${target.platform}-${target.arch}-${checkedCommit.slice(0, 12)}`;
  const metadata: UpdateMetadata = {
    schemaVersion: 1,
    updateId,
    product: 'nexa-chat',
    source: { version: policy.targetVersion, channel: 'beta', dataSchema: 1 },
    target: {
      version: policy.targetVersion,
      channel: 'beta',
      platform: target.platform,
      arch: target.arch,
      dataSchema: 1,
      commit: checkedCommit,
    },
    artifact: {
      name: `NexaChat-${policy.targetVersion}-beta-${target.platform}-${target.arch}.${artifactExtension(target.platform)}`,
      bytes: artifact.byteLength,
      sha256: sha256(artifact),
    },
    issuedAt: startedAt,
  };
  const envelope = signedEnvelope(metadata, privateKey, testPublicKey);
  const expectation: VerificationExpectation = {
    sourceVersion: policy.targetVersion,
    sourceChannel: 'beta',
    targetVersion: policy.targetVersion,
    targetChannel: 'beta',
    targetCommit: checkedCommit,
    keyEnvironment: 'test',
    ...target,
  };
  const verified = verifyUpdatePackage(
    policy,
    envelope,
    artifact,
    publicPem,
    expectation,
  );
  const scenarioResults: RecoveryEvidence['scenarios'] = [];
  const run = async (
    id: RequiredScenario,
    work: () => Promise<void> | void,
  ): Promise<void> => {
    try {
      await work();
      scenarioResults.push({ id, status: 'passed' });
    } catch {
      scenarioResults.push({ id, status: 'failed' });
    }
  };
  const withSandbox = async (
    work: (sandbox: UpdateRecoverySandbox) => Promise<void>,
  ): Promise<void> => {
    const root = await mkdtemp(resolve(tmpdir(), 'nexa-update-recovery-'));
    try {
      const sandbox = await UpdateRecoverySandbox.initialize(root, policy, {
        version: policy.targetVersion,
        channel: 'beta',
        artifact: Buffer.from('healthy prior application\n'),
        data: 'private local data',
        dataSchema: 1,
      });
      await work(sandbox);
    } finally {
      await rm(root, { recursive: true });
    }
  };
  const normalOptions = (): ApplyOptions => ({
    availableBytes: 1_000_000,
    migrate: (data) => Promise.resolve({ data: `${data}:migrated`, schema: 1 }),
    healthCheck: () => Promise.resolve(true),
  });

  await run('artifact-corruption', () => {
    const corrupted = Buffer.from(artifact);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    expectedFailure(
      () =>
        verifyUpdatePackage(
          policy,
          envelope,
          corrupted,
          publicPem,
          expectation,
        ),
      'artifact_integrity_failure',
    );
  });
  await run('download-interruption', () => {
    expectedFailure(
      () =>
        verifyUpdatePackage(
          policy,
          envelope,
          artifact.subarray(0, artifact.length - 1),
          publicPem,
          expectation,
        ),
      'artifact_size_mismatch',
    );
  });
  await run('insufficient-space', () =>
    withSandbox(async (sandbox) => {
      await expectedAsyncFailure(
        () =>
          sandbox.apply(verified, { ...normalOptions(), availableBytes: 0 }),
        'insufficient_space',
      );
      if ((await sandbox.active()).slotId !== 'baseline')
        fail('prior_slot_lost');
    }),
  );
  await run('invalid-signature', () => {
    const invalid = structuredClone(envelope);
    invalid.signature.signature = `${'A'.repeat(86)}==`;
    expectedFailure(
      () =>
        verifyUpdatePackage(policy, invalid, artifact, publicPem, expectation),
      'invalid_signature',
    );
  });
  await run('migration-failure', () =>
    withSandbox(async (sandbox) => {
      await expectedAsyncFailure(
        () =>
          sandbox.apply(verified, {
            ...normalOptions(),
            fault: 'migration-failure',
          }),
        'migration_failed',
      );
      const active = await sandbox.recover();
      if (active.data !== 'private local data') fail('local_data_changed');
    }),
  );
  await run('permission-failure', () =>
    withSandbox(async (sandbox) => {
      await expectedAsyncFailure(
        () =>
          sandbox.apply(verified, {
            ...normalOptions(),
            fault: 'permission-failure',
          }),
        'permission_denied',
      );
      if ((await sandbox.active()).slotId !== 'baseline')
        fail('prior_slot_lost');
    }),
  );
  await run('post-activation-health-failure', () =>
    withSandbox(async (sandbox) => {
      await expectedAsyncFailure(
        () =>
          sandbox.apply(verified, {
            ...normalOptions(),
            fault: 'post-activation-health-failure',
          }),
        'startup_health_failed',
      );
      const active = await sandbox.recover();
      if (active.slotId !== 'baseline') fail('automatic_rollback_failed');
    }),
  );
  await run('pre-activation-interruption', () =>
    withSandbox(async (sandbox) => {
      await expectedAsyncFailure(
        () =>
          sandbox.apply(verified, {
            ...normalOptions(),
            fault: 'pre-activation-interruption',
          }),
        'installation_interrupted',
      );
      if ((await sandbox.recover()).slotId !== 'baseline') {
        fail('prior_slot_lost');
      }
    }),
  );
  await run('release-channel-separation', () => {
    const isolatedMetadata = structuredClone(metadata);
    isolatedMetadata.source.channel = 'stable';
    isolatedMetadata.target.channel = 'nightly';
    const isolatedEnvelope = signedEnvelope(
      isolatedMetadata,
      privateKey,
      testPublicKey,
    );
    expectedFailure(
      () =>
        verifyUpdatePackage(policy, isolatedEnvelope, artifact, publicPem, {
          ...expectation,
          sourceChannel: 'stable',
          targetChannel: 'nightly',
        }),
      'channel_path_unsupported',
    );
  });
  await run('successful-activation-and-rollback', () =>
    withSandbox(async (sandbox) => {
      const activated = await sandbox.apply(verified, normalOptions());
      if (
        activated.slotId !== updateId ||
        activated.data !== 'private local data:migrated'
      ) {
        fail('activation_failed');
      }
      const rolledBack = await sandbox.rollback();
      if (
        rolledBack.slotId !== 'baseline' ||
        rolledBack.data !== 'private local data'
      ) {
        fail('rollback_failed');
      }
    }),
  );

  const passed =
    scenarioResults.length === policy.requiredScenarios.length &&
    scenarioResults.every((result) => result.status === 'passed') &&
    JSON.stringify(scenarioResults.map((result) => result.id)) ===
      JSON.stringify(policy.requiredScenarios);
  return {
    schemaVersion: 1,
    evidenceKind: 'signed-test-harness',
    version: policy.targetVersion,
    commit: checkedCommit,
    platform: target.platform,
    arch: target.arch,
    keyEnvironment: 'test',
    keyId: envelope.signature.keyId,
    metadataSha256: verified.metadataSha256,
    artifactSha256: metadata.artifact.sha256,
    startedAt,
    completedAt: new Date().toISOString(),
    scenarios: scenarioResults,
    passed,
  };
}

function options(args: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const argument of args) {
    const match = /^(--[a-z-]+)=(.+)$/.exec(argument);
    if (!match?.[1] || !match[2] || parsed.has(match[1])) {
      fail('invalid_option');
    }
    parsed.set(match[1], match[2]);
  }
  return parsed;
}

async function main(args: string[]): Promise<void> {
  const [command, ...rawOptions] = args;
  const parsed = options(rawOptions);
  const root = parsed.get('--repository-root') ?? REPOSITORY_ROOT;
  if (command === 'policy') {
    if ([...parsed.keys()].some((key) => key !== '--repository-root')) {
      fail('unsupported_policy_option');
    }
    const policy = await loadUpdatePolicy(root);
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, status: 'ok', targetVersion: policy.targetVersion, paths: policy.supportedPaths.length, targets: policy.platforms.length, scenarios: policy.requiredScenarios.length })}\n`,
    );
    return;
  }
  if (command !== 'evidence') fail('expected_policy_or_evidence');
  for (const key of parsed.keys()) {
    if (!['--repository-root', '--expected-commit'].includes(key)) {
      fail('unsupported_evidence_option');
    }
  }
  const expectedCommit = parsed.get('--expected-commit');
  if (!expectedCommit) fail('missing_expected_commit');
  const policy = await loadUpdatePolicy(root);
  const evidence = await runLocalRecoveryMatrix(policy, expectedCommit);
  const output = `${JSON.stringify(evidence)}\n`;
  if (Buffer.byteLength(output) > policy.evidence.maximumBytes) {
    fail('evidence_too_large');
  }
  process.stdout.write(output);
  if (!evidence.passed) process.exitCode = 2;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code =
      error instanceof UpdateRecoveryError ? error.code : 'unexpected_failure';
    process.stderr.write(`update_recovery_failed: ${code}\n`);
    process.exitCode = 1;
  });
}
