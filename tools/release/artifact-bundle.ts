import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSemanticVersion } from './versioning.js';

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const PRODUCT = 'NexaChat';
const MANIFEST_NAME = 'release-manifest.json';
const SIGNATURE_NAME = 'release-manifest.sig.json';
const CHECKSUMS_NAME = 'SHA256SUMS';
const PROVENANCE_NAME = 'provenance.intoto.jsonl';
const CONTROL_FILES = new Set([
  MANIFEST_NAME,
  SIGNATURE_NAME,
  CHECKSUMS_NAME,
  PROVENANCE_NAME,
]);
const MAX_FILES = 16;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_KEY_BYTES = 32 * 1024;
const MIN_SOURCE_EPOCH = 946_684_800;
const MAX_SOURCE_EPOCH = 4_102_444_800;
const PLATFORMS = ['macos', 'windows', 'linux'] as const;
const ARCHITECTURES = ['x64', 'arm64'] as const;
const CHANNELS = ['stable', 'beta', 'nightly'] as const;
const KEY_ENVIRONMENTS = ['test', 'production'] as const;
const EXTENSIONS = {
  macos: ['dmg', 'app.tar.gz'],
  windows: ['msi', 'nsis.zip'],
  linux: ['AppImage', 'deb', 'rpm', 'tar.gz'],
} as const;

type Platform = (typeof PLATFORMS)[number];
type Architecture = (typeof ARCHITECTURES)[number];
type Channel = (typeof CHANNELS)[number];
type KeyEnvironment = (typeof KEY_ENVIRONMENTS)[number];
type JsonObject = Record<string, unknown>;

interface FileRecord {
  name: string;
  kind: 'artifact' | 'sbom' | 'provenance';
  bytes: number;
  sha256: string;
}

interface BundleIdentity {
  version: string;
  channel: Channel;
  platform: Platform;
  arch: Architecture;
}

export interface AssembleOptions extends BundleIdentity {
  directory: string;
  repositoryRoot: string;
  commit: string;
  sourceDateEpoch: number;
  builderId: string;
  invocationId: string;
}

export interface SigningOptions extends BundleIdentity {
  directory: string;
  privateKey: string;
  keyEnvironment: KeyEnvironment;
  commit: string;
}

export interface VerificationOptions extends BundleIdentity {
  directory: string;
  trustedPublicKey: string;
  keyEnvironment: KeyEnvironment;
  commit: string;
}

export interface BundleSummary extends BundleIdentity {
  artifactCount: number;
  sbomCount: number;
  keyId?: string;
  signatureStatus: 'unsigned' | 'valid';
}

export class ArtifactValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactValidationError';
  }
}

function fail(message: string): never {
  throw new ArtifactValidationError(message);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonObject, keys: string[], context: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`unexpected ${context} fields`);
  }
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortedJson(nested)]),
  );
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortedJson(value), null, 2)}\n`;
}

function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function safeName(name: string): void {
  if (
    name.length === 0 ||
    name.length > 180 ||
    name.startsWith('.') ||
    basename(name) !== name ||
    name.includes('\r') ||
    name.includes('\n') ||
    name.includes(String.fromCodePoint(0))
  ) {
    fail('unsafe bundle filename');
  }
}

async function regularFile(
  path: string,
  maxBytes: number,
  context: string,
): Promise<number> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink())
    fail(`${context} must be a regular file`);
  if (details.size <= 0 || details.size > maxBytes)
    fail(`${context} has an invalid size`);
  return details.size;
}

async function readBounded(
  path: string,
  maxBytes: number,
  context: string,
): Promise<Buffer> {
  await regularFile(path, maxBytes, context);
  return readFile(path);
}

async function hashFile(
  path: string,
  maxBytes: number,
  context: string,
): Promise<{ bytes: number; sha256: string }> {
  const expectedBytes = await regularFile(path, maxBytes, context);
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, {
    highWaterMark: 1024 * 1024,
  })) {
    if (!Buffer.isBuffer(chunk)) fail(`${context} could not be hashed`);
    bytes += chunk.length;
    if (bytes > maxBytes) fail(`${context} changed or exceeded its size limit`);
    digest.update(chunk);
  }
  if (bytes !== expectedBytes) fail(`${context} changed while it was hashed`);
  return { bytes, sha256: digest.digest('hex') };
}

async function readJson(
  path: string,
  maxBytes: number,
  context: string,
): Promise<JsonObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      (await readBounded(path, maxBytes, context)).toString('utf8'),
    );
  } catch (error) {
    if (error instanceof ArtifactValidationError) throw error;
    return fail(`${context} is not valid JSON`);
  }
  if (!isObject(parsed)) fail(`${context} must be a JSON object`);
  return parsed;
}

function validateIdentity(identity: BundleIdentity): void {
  parseSemanticVersion(identity.version);
  if (!CHANNELS.includes(identity.channel)) fail('unsupported release channel');
  if (!PLATFORMS.includes(identity.platform)) fail('unsupported platform');
  if (!ARCHITECTURES.includes(identity.arch)) fail('unsupported architecture');
}

function artifactBase(identity: BundleIdentity): string {
  return `${PRODUCT}-${identity.version}-${identity.channel}-${identity.platform}-${identity.arch}`;
}

function expectedSbomNames(version: string): string[] {
  return [
    `${PRODUCT}-${version}-desktop-cargo.cdx.json`,
    `${PRODUCT}-${version}-source-npm.cdx.json`,
  ];
}

function classifyInput(
  name: string,
  identity: BundleIdentity,
): 'artifact' | 'sbom' | undefined {
  if (expectedSbomNames(identity.version).includes(name)) return 'sbom';
  const base = `${artifactBase(identity)}.`;
  if (!name.startsWith(base)) return undefined;
  const extension = name.slice(base.length);
  return (EXTENSIONS[identity.platform] as readonly string[]).includes(
    extension,
  )
    ? 'artifact'
    : undefined;
}

async function validateSbom(path: string): Promise<void> {
  const sbom = await readJson(path, MAX_METADATA_BYTES, 'SBOM');
  if (
    sbom.bomFormat !== 'CycloneDX' ||
    !['1.5', '1.6'].includes(String(sbom.specVersion)) ||
    sbom.version !== 1 ||
    (!Array.isArray(sbom.components) && !isObject(sbom.metadata))
  ) {
    fail('invalid CycloneDX SBOM');
  }
}

async function inputRecords(
  directory: string,
  identity: BundleIdentity,
): Promise<FileRecord[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const inputEntries = entries.filter(
    (entry) => !CONTROL_FILES.has(entry.name),
  );
  if (inputEntries.length === 0 || inputEntries.length > MAX_FILES)
    fail('bundle file count is out of bounds');
  const records: FileRecord[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    safeName(entry.name);
    if (CONTROL_FILES.has(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink())
      fail('bundle inputs must be regular files');
    const kind = classifyInput(entry.name, identity);
    if (!kind) fail(`unexpected bundle input: ${entry.name}`);
    const path = resolve(directory, entry.name);
    const hashed = await hashFile(
      path,
      kind === 'artifact' ? MAX_ARTIFACT_BYTES : MAX_METADATA_BYTES,
      kind,
    );
    if (kind === 'sbom') await validateSbom(path);
    records.push({ name: entry.name, kind, ...hashed });
  }
  if (records.filter((record) => record.kind === 'artifact').length === 0) {
    fail('bundle requires at least one platform artifact');
  }
  const sboms = records
    .filter((record) => record.kind === 'sbom')
    .map((record) => record.name);
  if (
    JSON.stringify(sboms) !==
    JSON.stringify(expectedSbomNames(identity.version))
  ) {
    fail('bundle requires exact npm and Cargo SBOMs');
  }
  return records;
}

async function materialRecord(
  repositoryRoot: string,
  path: string,
): Promise<JsonObject> {
  const absolute = resolve(repositoryRoot, path);
  const contents = await readBounded(
    absolute,
    MAX_METADATA_BYTES,
    'dependency lock',
  );
  return { uri: path, digest: { sha256: sha256(contents) } };
}

function sourceTimestamp(epoch: number): string {
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < MIN_SOURCE_EPOCH ||
    epoch > MAX_SOURCE_EPOCH
  ) {
    fail('source date epoch is out of bounds');
  }
  return new Date(epoch * 1000).toISOString();
}

async function assertRepositoryVersion(
  repositoryRoot: string,
  version: string,
): Promise<void> {
  const manifest = await readJson(
    resolve(repositoryRoot, 'package.json'),
    MAX_METADATA_BYTES,
    'root manifest',
  );
  if (manifest.version !== version)
    fail('artifact version does not match repository version');
}

function assertCommit(commit: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
    fail('commit must be a full lowercase object id');
}

function assertBuildIdentity(builderId: string, invocationId: string): void {
  if (builderId !== 'urn:nexa:builder:test') {
    let parsed: URL;
    try {
      parsed = new URL(builderId);
    } catch {
      return fail('builder id must be an HTTPS URI or the test fixture URN');
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      builderId.length > 300
    ) {
      fail(
        'builder id must be an HTTPS URI without credentials, query, or fragment',
      );
    }
  }
  if (
    invocationId.length === 0 ||
    invocationId.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(invocationId)
  ) {
    fail('invalid build invocation id');
  }
}

async function writeNewOrIdentical(
  path: string,
  contents: string,
): Promise<void> {
  try {
    const current = await readFile(path, 'utf8');
    if (current !== contents)
      fail(`refusing to replace different ${basename(path)}`);
  } catch (error) {
    if (error instanceof ArtifactValidationError) throw error;
    const code =
      isObject(error) && typeof error.code === 'string' ? error.code : '';
    if (code !== 'ENOENT') throw error;
    await writeFile(path, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o644,
    });
  }
}

export async function assembleBundle(
  options: AssembleOptions,
): Promise<BundleSummary> {
  validateIdentity(options);
  assertCommit(options.commit);
  assertBuildIdentity(options.builderId, options.invocationId);
  const timestamp = sourceTimestamp(options.sourceDateEpoch);
  const directory = resolve(options.directory);
  const repositoryRoot = resolve(options.repositoryRoot);
  const directoryDetails = await lstat(directory);
  if (!directoryDetails.isDirectory() || directoryDetails.isSymbolicLink())
    fail('bundle directory is not a directory');
  await assertRepositoryVersion(repositoryRoot, options.version);
  const inputs = await inputRecords(directory, options);
  const materials = await Promise.all([
    Promise.resolve({
      uri: `git+https://github.com/cryptnetworks/NexaChat@${options.commit}`,
      digest: {
        [options.commit.length === 40 ? 'sha1' : 'sha256']: options.commit,
      },
    }),
    materialRecord(repositoryRoot, 'package-lock.json'),
    materialRecord(repositoryRoot, 'apps/desktop/src-tauri/Cargo.lock'),
  ]);
  const subjects = inputs.map((record) => ({
    name: record.name,
    digest: { sha256: record.sha256 },
  }));
  const provenance = canonicalJson({
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: subjects,
    predicate: {
      buildDefinition: {
        buildType:
          'https://github.com/cryptnetworks/NexaChat/tools/release/artifact-bundle@v1',
        externalParameters: {
          version: options.version,
          channel: options.channel,
          target: { platform: options.platform, arch: options.arch },
        },
        internalParameters: { sourceDateEpoch: options.sourceDateEpoch },
        resolvedDependencies: materials,
      },
      runDetails: {
        builder: { id: options.builderId },
        metadata: {
          invocationId: options.invocationId,
          startedOn: timestamp,
          finishedOn: timestamp,
        },
      },
    },
  });
  await writeNewOrIdentical(resolve(directory, PROVENANCE_NAME), provenance);
  const provenanceRecord: FileRecord = {
    name: PROVENANCE_NAME,
    kind: 'provenance',
    bytes: Buffer.byteLength(provenance),
    sha256: sha256(provenance),
  };
  const contentRecords = [...inputs, provenanceRecord].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const checksums = `${contentRecords.map((record) => `${record.sha256}  ${record.name}`).join('\n')}\n`;
  await writeNewOrIdentical(resolve(directory, CHECKSUMS_NAME), checksums);
  const manifest = canonicalJson({
    schemaVersion: 1,
    product: 'nexa-chat',
    version: options.version,
    channel: options.channel,
    target: { platform: options.platform, arch: options.arch },
    source: {
      repository: 'https://github.com/cryptnetworks/NexaChat',
      commit: options.commit,
      sourceDateEpoch: options.sourceDateEpoch,
    },
    files: contentRecords,
    checksums: { name: CHECKSUMS_NAME, sha256: sha256(checksums) },
    provenance: { name: PROVENANCE_NAME, sha256: provenanceRecord.sha256 },
    signing: { algorithm: 'Ed25519', detached: true, publicKeyEmbedded: false },
  });
  await writeNewOrIdentical(resolve(directory, MANIFEST_NAME), manifest);
  return {
    version: options.version,
    channel: options.channel,
    platform: options.platform,
    arch: options.arch,
    artifactCount: inputs.filter((record) => record.kind === 'artifact').length,
    sbomCount: inputs.filter((record) => record.kind === 'sbom').length,
    signatureStatus: 'unsigned',
  };
}

function parseFileRecord(value: unknown): FileRecord {
  if (!isObject(value)) fail('invalid manifest file record');
  exactKeys(value, ['name', 'kind', 'bytes', 'sha256'], 'manifest file record');
  if (
    typeof value.name !== 'string' ||
    !['artifact', 'sbom', 'provenance'].includes(String(value.kind)) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) <= 0 ||
    !/^[0-9a-f]{64}$/.test(String(value.sha256))
  ) {
    fail('invalid manifest file record');
  }
  safeName(value.name);
  return {
    name: value.name,
    kind: value.kind as FileRecord['kind'],
    bytes: Number(value.bytes),
    sha256: String(value.sha256),
  };
}

async function inspectUnsignedBundle(
  directoryInput: string,
  expected: BundleIdentity & { commit: string },
): Promise<{ manifestBytes: Buffer; records: FileRecord[] }> {
  validateIdentity(expected);
  assertCommit(expected.commit);
  const directory = resolve(directoryInput);
  const manifestBytes = await readBounded(
    resolve(directory, MANIFEST_NAME),
    MAX_METADATA_BYTES,
    'manifest',
  );
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    return fail('manifest is not valid JSON');
  }
  if (!isObject(manifest)) fail('manifest must be a JSON object');
  exactKeys(
    manifest,
    [
      'schemaVersion',
      'product',
      'version',
      'channel',
      'target',
      'source',
      'files',
      'checksums',
      'provenance',
      'signing',
    ],
    'manifest',
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.product !== 'nexa-chat' ||
    manifest.version !== expected.version ||
    manifest.channel !== expected.channel
  ) {
    fail('manifest identity mismatch');
  }
  if (
    !isObject(manifest.target) ||
    manifest.target.platform !== expected.platform ||
    manifest.target.arch !== expected.arch
  ) {
    fail('manifest target mismatch');
  }
  exactKeys(manifest.target, ['platform', 'arch'], 'manifest target');
  if (!isObject(manifest.source)) fail('invalid source declaration');
  exactKeys(
    manifest.source,
    ['repository', 'commit', 'sourceDateEpoch'],
    'source declaration',
  );
  if (
    manifest.source.repository !==
      'https://github.com/cryptnetworks/NexaChat' ||
    typeof manifest.source.commit !== 'string' ||
    manifest.source.commit !== expected.commit ||
    typeof manifest.source.sourceDateEpoch !== 'number'
  ) {
    fail('invalid source declaration');
  }
  assertCommit(manifest.source.commit);
  sourceTimestamp(manifest.source.sourceDateEpoch);
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length < 4 ||
    manifest.files.length > MAX_FILES + 1
  ) {
    fail('manifest file count is out of bounds');
  }
  const records = manifest.files.map(parseFileRecord);
  if (new Set(records.map((record) => record.name)).size !== records.length) {
    fail('manifest contains duplicate files');
  }
  if (
    JSON.stringify(records.map((record) => record.name)) !==
    JSON.stringify(records.map((record) => record.name).sort())
  ) {
    fail('manifest files are not sorted');
  }
  const artifactRecords = records.filter(
    (record) => record.kind === 'artifact',
  );
  const sbomRecords = records.filter((record) => record.kind === 'sbom');
  const provenanceRecords = records.filter(
    (record) => record.kind === 'provenance',
  );
  if (
    artifactRecords.length === 0 ||
    !artifactRecords.every(
      (record) => classifyInput(record.name, expected) === 'artifact',
    ) ||
    JSON.stringify(sbomRecords.map((record) => record.name)) !==
      JSON.stringify(expectedSbomNames(expected.version)) ||
    provenanceRecords.length !== 1 ||
    provenanceRecords[0]?.name !== PROVENANCE_NAME
  ) {
    fail('manifest payload set does not match the expected target');
  }
  for (const record of records) {
    const path = resolve(directory, record.name);
    const hashed = await hashFile(
      path,
      record.kind === 'artifact' ? MAX_ARTIFACT_BYTES : MAX_METADATA_BYTES,
      'manifest payload',
    );
    if (hashed.bytes !== record.bytes || hashed.sha256 !== record.sha256) {
      fail(`digest mismatch: ${record.name}`);
    }
  }
  if (!isObject(manifest.checksums)) {
    fail('invalid checksum declaration');
  }
  exactKeys(manifest.checksums, ['name', 'sha256'], 'checksum declaration');
  if (manifest.checksums.name !== CHECKSUMS_NAME)
    fail('invalid checksum declaration');
  const checksumBytes = await readBounded(
    resolve(directory, CHECKSUMS_NAME),
    MAX_METADATA_BYTES,
    'checksums',
  );
  const expectedChecksums = `${records.map((record) => `${record.sha256}  ${record.name}`).join('\n')}\n`;
  if (
    checksumBytes.toString('utf8') !== expectedChecksums ||
    manifest.checksums.sha256 !== sha256(checksumBytes)
  ) {
    fail('checksum file mismatch');
  }
  if (!isObject(manifest.provenance)) fail('provenance declaration mismatch');
  exactKeys(manifest.provenance, ['name', 'sha256'], 'provenance declaration');
  if (
    manifest.provenance.name !== PROVENANCE_NAME ||
    manifest.provenance.sha256 !==
      records.find((record) => record.name === PROVENANCE_NAME)?.sha256
  ) {
    fail('provenance declaration mismatch');
  }
  if (!isObject(manifest.signing)) fail('unsupported signing policy');
  exactKeys(
    manifest.signing,
    ['algorithm', 'detached', 'publicKeyEmbedded'],
    'signing policy',
  );
  if (
    manifest.signing.algorithm !== 'Ed25519' ||
    manifest.signing.detached !== true ||
    manifest.signing.publicKeyEmbedded !== false
  ) {
    fail('unsupported signing policy');
  }
  const provenance = await readJson(
    resolve(directory, PROVENANCE_NAME),
    MAX_METADATA_BYTES,
    'provenance',
  );
  const expectedSubjects = records
    .filter((record) => record.kind !== 'provenance')
    .map((record) => ({
      name: record.name,
      digest: { sha256: record.sha256 },
    }));
  if (
    provenance._type !== 'https://in-toto.io/Statement/v1' ||
    provenance.predicateType !== 'https://slsa.dev/provenance/v1' ||
    canonicalJson(provenance.subject) !== canonicalJson(expectedSubjects) ||
    !isObject(provenance.predicate) ||
    !isObject(provenance.predicate.buildDefinition) ||
    !isObject(provenance.predicate.buildDefinition.externalParameters) ||
    provenance.predicate.buildDefinition.externalParameters.version !==
      expected.version ||
    provenance.predicate.buildDefinition.externalParameters.channel !==
      expected.channel ||
    !isObject(provenance.predicate.buildDefinition.externalParameters.target) ||
    provenance.predicate.buildDefinition.externalParameters.target.platform !==
      expected.platform ||
    provenance.predicate.buildDefinition.externalParameters.target.arch !==
      expected.arch ||
    !isObject(provenance.predicate.buildDefinition.internalParameters) ||
    provenance.predicate.buildDefinition.internalParameters.sourceDateEpoch !==
      manifest.source.sourceDateEpoch
  ) {
    fail('provenance identity mismatch');
  }
  exactKeys(
    provenance,
    ['_type', 'predicateType', 'subject', 'predicate'],
    'provenance',
  );
  exactKeys(
    provenance.predicate,
    ['buildDefinition', 'runDetails'],
    'provenance predicate',
  );
  const buildDefinition = provenance.predicate.buildDefinition;
  exactKeys(
    buildDefinition,
    [
      'buildType',
      'externalParameters',
      'internalParameters',
      'resolvedDependencies',
    ],
    'provenance build definition',
  );
  const resolvedDependencies: unknown = buildDefinition.resolvedDependencies;
  if (
    buildDefinition.buildType !==
      'https://github.com/cryptnetworks/NexaChat/tools/release/artifact-bundle@v1' ||
    !Array.isArray(resolvedDependencies) ||
    resolvedDependencies.length !== 3
  ) {
    fail('provenance build definition mismatch');
  }
  const sourceMaterial: unknown = resolvedDependencies[0];
  const expectedCommitAlgorithm =
    expected.commit.length === 40 ? 'sha1' : 'sha256';
  if (
    !isObject(sourceMaterial) ||
    sourceMaterial.uri !==
      `git+https://github.com/cryptnetworks/NexaChat@${expected.commit}` ||
    !isObject(sourceMaterial.digest) ||
    sourceMaterial.digest[expectedCommitAlgorithm] !== expected.commit
  ) {
    fail('provenance source material mismatch');
  }
  if (!isObject(provenance.predicate.runDetails)) {
    fail('provenance run details mismatch');
  }
  const runDetails = provenance.predicate.runDetails;
  exactKeys(runDetails, ['builder', 'metadata'], 'provenance run details');
  if (
    !isObject(runDetails.builder) ||
    typeof runDetails.builder.id !== 'string' ||
    !isObject(runDetails.metadata) ||
    typeof runDetails.metadata.invocationId !== 'string'
  ) {
    fail('provenance run details mismatch');
  }
  assertBuildIdentity(runDetails.builder.id, runDetails.metadata.invocationId);
  const expectedTimestamp = sourceTimestamp(manifest.source.sourceDateEpoch);
  if (
    runDetails.metadata.startedOn !== expectedTimestamp ||
    runDetails.metadata.finishedOn !== expectedTimestamp
  ) {
    fail('provenance timestamp mismatch');
  }
  if (
    canonicalJson(provenance) !==
    (await readFile(resolve(directory, PROVENANCE_NAME), 'utf8'))
  ) {
    fail('provenance is not canonical JSON');
  }
  if (canonicalJson(manifest) !== manifestBytes.toString('utf8')) {
    fail('manifest is not canonical JSON');
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const expectedNames = new Set([
    ...records.map((record) => record.name),
    MANIFEST_NAME,
    CHECKSUMS_NAME,
    ...(entries.some((entry) => entry.name === SIGNATURE_NAME)
      ? [SIGNATURE_NAME]
      : []),
  ]);
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !expectedNames.has(entry.name)
    ) {
      fail(`unexpected file in assembled bundle: ${entry.name}`);
    }
  }
  if (entries.length !== expectedNames.size)
    fail('assembled bundle is incomplete');
  return { manifestBytes, records };
}

function publicKeyId(publicKey: ReturnType<typeof createPublicKey>): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `sha256:${sha256(der)}`;
}

async function privateKeyFromFile(
  pathInput: string,
): Promise<ReturnType<typeof createPrivateKey>> {
  const path = resolve(pathInput);
  const details = await lstat(path);
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size <= 0 ||
    details.size > MAX_KEY_BYTES
  ) {
    fail('private key must be a bounded regular file');
  }
  if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
    fail('private key file must not be accessible to group or other users');
  }
  const bytes = await readFile(path);
  try {
    const key = createPrivateKey(bytes);
    if (key.asymmetricKeyType !== 'ed25519')
      fail('signing key must be Ed25519');
    return key;
  } catch (error) {
    if (error instanceof ArtifactValidationError) throw error;
    return fail('private key could not be loaded');
  } finally {
    bytes.fill(0);
  }
}

async function publicKeyFromFile(
  pathInput: string,
): Promise<ReturnType<typeof createPublicKey>> {
  const bytes = await readBounded(
    resolve(pathInput),
    MAX_KEY_BYTES,
    'trusted public key',
  );
  try {
    const key = createPublicKey(bytes);
    if (key.asymmetricKeyType !== 'ed25519')
      fail('trusted public key must be Ed25519');
    return key;
  } catch (error) {
    if (error instanceof ArtifactValidationError) throw error;
    return fail('trusted public key could not be loaded');
  }
}

function assertKeyOutsideBundle(directory: string, keyPath: string): void {
  const relativePath = relative(resolve(directory), resolve(keyPath));
  if (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !relativePath.startsWith('/'))
  ) {
    fail('signing keys must remain outside the artifact bundle');
  }
}

export async function signBundle(
  options: SigningOptions,
): Promise<BundleSummary> {
  if (!KEY_ENVIRONMENTS.includes(options.keyEnvironment))
    fail('invalid key environment');
  assertKeyOutsideBundle(options.directory, options.privateKey);
  const inspected = await inspectUnsignedBundle(options.directory, options);
  const privateKey = await privateKeyFromFile(options.privateKey);
  const publicJwk = structuredClone(privateKey.export({ format: 'jwk' }));
  delete publicJwk.d;
  const publicKey = createPublicKey({
    key: publicJwk,
    format: 'jwk',
  });
  const keyId = publicKeyId(publicKey);
  const signature = cryptoSign(null, inspected.manifestBytes, privateKey);
  const record = canonicalJson({
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId,
    keyEnvironment: options.keyEnvironment,
    manifestSha256: sha256(inspected.manifestBytes),
    signature: signature.toString('base64'),
  });
  await writeNewOrIdentical(resolve(options.directory, SIGNATURE_NAME), record);
  return {
    version: options.version,
    channel: options.channel,
    platform: options.platform,
    arch: options.arch,
    artifactCount: inspected.records.filter((file) => file.kind === 'artifact')
      .length,
    sbomCount: inspected.records.filter((file) => file.kind === 'sbom').length,
    keyId,
    signatureStatus: 'valid',
  };
}

export async function verifyBundle(
  options: VerificationOptions,
): Promise<BundleSummary> {
  if (!KEY_ENVIRONMENTS.includes(options.keyEnvironment))
    fail('invalid key environment');
  assertKeyOutsideBundle(options.directory, options.trustedPublicKey);
  const inspected = await inspectUnsignedBundle(options.directory, options);
  const signatureRecord = await readJson(
    resolve(options.directory, SIGNATURE_NAME),
    MAX_KEY_BYTES,
    'signature record',
  );
  exactKeys(
    signatureRecord,
    [
      'schemaVersion',
      'algorithm',
      'keyId',
      'keyEnvironment',
      'manifestSha256',
      'signature',
    ],
    'signature record',
  );
  if (
    signatureRecord.schemaVersion !== 1 ||
    signatureRecord.algorithm !== 'Ed25519' ||
    signatureRecord.keyEnvironment !== options.keyEnvironment ||
    signatureRecord.manifestSha256 !== sha256(inspected.manifestBytes) ||
    typeof signatureRecord.signature !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signatureRecord.signature)
  ) {
    fail('invalid signature record');
  }
  const publicKey = await publicKeyFromFile(options.trustedPublicKey);
  const keyId = publicKeyId(publicKey);
  if (signatureRecord.keyId !== keyId) fail('untrusted signing key');
  const signature = Buffer.from(signatureRecord.signature, 'base64');
  if (
    signature.length !== 64 ||
    !cryptoVerify(null, inspected.manifestBytes, publicKey, signature)
  ) {
    fail('release manifest signature is invalid');
  }
  return {
    version: options.version,
    channel: options.channel,
    platform: options.platform,
    arch: options.arch,
    artifactCount: inspected.records.filter((file) => file.kind === 'artifact')
      .length,
    sbomCount: inspected.records.filter((file) => file.kind === 'sbom').length,
    keyId,
    signatureStatus: 'valid',
  };
}

function optionMap(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (const argument of args) {
    const match = /^(--[a-z-]+)=(.+)$/.exec(argument);
    if (!match?.[1] || !match[2] || options.has(match[1]))
      fail('invalid or duplicate option');
    options.set(match[1], match[2]);
  }
  return options;
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) fail(`missing ${name}`);
  return value;
}

function identityOptions(options: Map<string, string>): BundleIdentity {
  return {
    version: requiredOption(options, '--version'),
    channel: requiredOption(options, '--channel') as Channel,
    platform: requiredOption(options, '--platform') as Platform,
    arch: requiredOption(options, '--arch') as Architecture,
  };
}

function assertOnlyOptions(
  options: Map<string, string>,
  allowed: string[],
): void {
  for (const name of options.keys()) {
    if (!allowed.includes(name)) fail(`unsupported option: ${name}`);
  }
}

function safeSummary(summary: BundleSummary): JsonObject {
  return {
    schemaVersion: 1,
    status: 'ok',
    version: summary.version,
    channel: summary.channel,
    target: { platform: summary.platform, arch: summary.arch },
    artifactCount: summary.artifactCount,
    sbomCount: summary.sbomCount,
    signatureStatus: summary.signatureStatus,
    ...(summary.keyId ? { keyId: summary.keyId } : {}),
  };
}

async function main(args: string[]): Promise<void> {
  const [command, ...rawOptions] = args;
  const options = optionMap(rawOptions);
  const identity = identityOptions(options);
  let summary: BundleSummary;
  if (command === 'assemble') {
    assertOnlyOptions(options, [
      '--directory',
      '--repository-root',
      '--version',
      '--channel',
      '--platform',
      '--arch',
      '--commit',
      '--source-date-epoch',
      '--builder-id',
      '--invocation-id',
    ]);
    summary = await assembleBundle({
      ...identity,
      directory: requiredOption(options, '--directory'),
      repositoryRoot: options.get('--repository-root') ?? REPOSITORY_ROOT,
      commit: requiredOption(options, '--commit'),
      sourceDateEpoch: Number(requiredOption(options, '--source-date-epoch')),
      builderId: requiredOption(options, '--builder-id'),
      invocationId: requiredOption(options, '--invocation-id'),
    });
  } else if (command === 'sign') {
    assertOnlyOptions(options, [
      '--directory',
      '--private-key',
      '--key-environment',
      '--commit',
      '--version',
      '--channel',
      '--platform',
      '--arch',
    ]);
    summary = await signBundle({
      ...identity,
      directory: requiredOption(options, '--directory'),
      privateKey: requiredOption(options, '--private-key'),
      keyEnvironment: requiredOption(
        options,
        '--key-environment',
      ) as KeyEnvironment,
      commit: requiredOption(options, '--commit'),
    });
  } else if (command === 'verify') {
    assertOnlyOptions(options, [
      '--directory',
      '--trusted-public-key',
      '--key-environment',
      '--commit',
      '--version',
      '--channel',
      '--platform',
      '--arch',
    ]);
    summary = await verifyBundle({
      ...identity,
      directory: requiredOption(options, '--directory'),
      trustedPublicKey: requiredOption(options, '--trusted-public-key'),
      keyEnvironment: requiredOption(
        options,
        '--key-environment',
      ) as KeyEnvironment,
      commit: requiredOption(options, '--commit'),
    });
  } else {
    fail('expected assemble, sign, or verify');
  }
  process.stdout.write(`${JSON.stringify(safeSummary(summary))}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof ArtifactValidationError
        ? error.message
        : 'unexpected failure';
    process.stderr.write(`artifact_validation_failed: ${message}\n`);
    process.exitCode = 1;
  });
}
