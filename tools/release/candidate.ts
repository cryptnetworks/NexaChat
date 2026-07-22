import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './artifact-bundle.js';
import { parseSemanticVersion } from './versioning.js';

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const POLICY_PATH = 'release/candidate-policy.json';
const LOCK_PATHS = [
  'apps/desktop/src-tauri/Cargo.lock',
  'package-lock.json',
] as const;
const PLATFORMS = ['linux', 'macos', 'windows'] as const;
const ARCHITECTURES = ['arm64', 'x64'] as const;
const CHANNELS = ['stable', 'beta', 'nightly'] as const;
const CHECK_STATUSES = ['passed', 'failed', 'not-run'] as const;
const RISK_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
const RISK_STATUSES = ['open', 'accepted', 'resolved'] as const;
const GLOBAL_CHECKS = [
  'accessibility',
  'authorization',
  'backup-restore',
  'clean-install',
  'dependency-audit',
  'failure-recovery',
  'format',
  'lint',
  'localization',
  'performance',
  'postgresql',
  'production-build',
  'provenance',
  'realtime-capacity',
  'rollback-rehearsal',
  'secret-scan',
  'unit-integration',
  'upgrade-rehearsal',
] as const;
const TARGET_CHECKS = [
  'clean-install',
  'credential-store',
  'desktop-security',
  'native-notifications',
  'package',
  'reconnect',
  'reproducible-build',
  'smoke',
  'update-recovery',
] as const;
const REQUIRED_TARGETS = [
  { platform: 'linux', arch: 'x64' },
  { platform: 'macos', arch: 'arm64' },
  { platform: 'macos', arch: 'x64' },
  { platform: 'windows', arch: 'x64' },
] as const;
const ARTIFACT_FORMATS = {
  linux: ['AppImage', 'deb', 'rpm', 'tar.gz'],
  macos: ['dmg', 'app.tar.gz'],
  windows: ['msi', 'nsis.zip'],
} as const;

type Platform = (typeof PLATFORMS)[number];
type Architecture = (typeof ARCHITECTURES)[number];
type Channel = (typeof CHANNELS)[number];
type JsonObject = Record<string, unknown>;
type CheckStatus = (typeof CHECK_STATUSES)[number];

interface TargetIdentity {
  platform: Platform;
  arch: Architecture;
}

export interface CandidatePolicy {
  schemaVersion: 1;
  product: 'nexa-chat';
  targetVersion: string;
  retentionDays: number;
  maxEvidenceBytes: number;
  maxResidualRisks: number;
  maximumAcceptedRisk: 'medium';
  requiredTargets: TargetIdentity[];
  requiredGlobalChecks: string[];
  requiredTargetChecks: string[];
  requireProductionDetachedSignature: boolean;
  requireNativeSignatureOn: Platform[];
  requireBuildAttestation: boolean;
  requireBothSboms: boolean;
}

export interface CandidateDecision {
  schemaVersion: 1;
  candidateId: string;
  version: string;
  commit: string;
  status: 'go' | 'no-go';
  evidenceSha256: string;
  targetsPassed: number;
  targetsRequired: number;
  failures: string[];
}

export class CandidateValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CandidateValidationError';
  }
}

function fail(message: string): never {
  throw new CandidateValidationError(message);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonObject, keys: string[], context: string): void {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...keys].sort())
  ) {
    fail(`unexpected ${context} fields`);
  }
}

function text(value: unknown, maximum: number, context: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.includes(String.fromCodePoint(0))
  ) {
    fail(`invalid ${context}`);
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
    fail(`invalid ${context}`);
  }
  return Number(value);
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') fail(`invalid ${context}`);
  return value;
}

function digest(value: unknown, context: string): string {
  const parsed = text(value, 64, context);
  if (!/^[0-9a-f]{64}$/.test(parsed)) fail(`invalid ${context}`);
  return parsed;
}

function optionalDigest(value: unknown, context: string): string | null {
  return value === null ? null : digest(value, context);
}

function timestamp(value: unknown, context: string): string {
  const parsed = text(value, 40, context);
  try {
    if (new Date(parsed).toISOString() !== parsed) fail(`invalid ${context}`);
  } catch {
    fail(`invalid ${context}`);
  }
  return parsed;
}

function calendarDate(value: unknown, context: string): string {
  const parsed = text(value, 10, context);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) fail(`invalid ${context}`);
  const date = new Date(`${parsed}T00:00:00.000Z`);
  if (
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== parsed
  ) {
    fail(`invalid ${context}`);
  }
  return parsed;
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  context: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    fail(`invalid ${context}`);
  }
  return value as T;
}

function targetKey(target: TargetIdentity): string {
  return `${target.platform}/${target.arch}`;
}

function validArtifactName(
  name: string,
  version: string,
  channel: Channel,
  target: TargetIdentity,
): boolean {
  const stem = `NexaChat-${version}-${channel}-${target.platform}-${target.arch}`;
  return ARTIFACT_FORMATS[target.platform].some(
    (format) => name === `${stem}.${format}`,
  );
}

function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function readJson(
  path: string,
  maxBytes: number,
  context: string,
): Promise<{
  raw: string;
  value: JsonObject;
}> {
  const details = await lstat(path);
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size <= 0 ||
    details.size > maxBytes
  ) {
    fail(`${context} must be a bounded regular file`);
  }
  const raw = await readFile(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail(`${context} is not valid JSON`);
  }
  if (!isObject(value)) fail(`${context} must be a JSON object`);
  return { raw, value };
}

function parseTargetList(value: unknown): TargetIdentity[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    fail('invalid required target matrix');
  }
  const targets = value.map((entry) => {
    if (!isObject(entry)) return fail('invalid required target');
    exactKeys(entry, ['platform', 'arch'], 'required target');
    return {
      platform: oneOf(entry.platform, PLATFORMS, 'target platform'),
      arch: oneOf(entry.arch, ARCHITECTURES, 'target architecture'),
    };
  });
  const keys = targets.map(targetKey);
  if (
    new Set(keys).size !== keys.length ||
    JSON.stringify(keys) !== JSON.stringify([...keys].sort())
  ) {
    fail('required targets must be unique and sorted');
  }
  return targets;
}

function exactStringArray(
  value: unknown,
  expected: readonly string[],
  context: string,
): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(`invalid ${context}`);
  }
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    fail(`${context} is incomplete or unordered`);
  }
  return [...expected];
}

function parsePolicy(raw: JsonObject): CandidatePolicy {
  exactKeys(
    raw,
    [
      'schemaVersion',
      'product',
      'targetVersion',
      'retentionDays',
      'maxEvidenceBytes',
      'maxResidualRisks',
      'maximumAcceptedRisk',
      'requiredTargets',
      'requiredGlobalChecks',
      'requiredTargetChecks',
      'requireProductionDetachedSignature',
      'requireNativeSignatureOn',
      'requireBuildAttestation',
      'requireBothSboms',
    ],
    'candidate policy',
  );
  if (raw.schemaVersion !== 1 || raw.product !== 'nexa-chat') {
    fail('unsupported candidate policy');
  }
  const targetVersion = text(raw.targetVersion, 64, 'candidate target version');
  parseSemanticVersion(targetVersion);
  const requiredTargets = parseTargetList(raw.requiredTargets);
  const requiredGlobalChecks = exactStringArray(
    raw.requiredGlobalChecks,
    GLOBAL_CHECKS,
    'global checks',
  );
  const requiredTargetChecks = exactStringArray(
    raw.requiredTargetChecks,
    TARGET_CHECKS,
    'target checks',
  );
  const nativePlatforms = exactStringArray(
    raw.requireNativeSignatureOn,
    ['macos', 'windows'],
    'native signature platforms',
  ) as Platform[];
  const policy: CandidatePolicy = {
    schemaVersion: 1,
    product: 'nexa-chat',
    targetVersion,
    retentionDays: integer(raw.retentionDays, 180, 3650, 'retention days'),
    maxEvidenceBytes: integer(
      raw.maxEvidenceBytes,
      16_384,
      1_048_576,
      'maximum evidence bytes',
    ),
    maxResidualRisks: integer(
      raw.maxResidualRisks,
      1,
      32,
      'maximum residual risks',
    ),
    maximumAcceptedRisk: oneOf(
      raw.maximumAcceptedRisk,
      ['medium'] as const,
      'maximum accepted risk',
    ),
    requiredTargets,
    requiredGlobalChecks,
    requiredTargetChecks,
    requireProductionDetachedSignature: boolean(
      raw.requireProductionDetachedSignature,
      'detached signature requirement',
    ),
    requireNativeSignatureOn: nativePlatforms,
    requireBuildAttestation: boolean(
      raw.requireBuildAttestation,
      'attestation requirement',
    ),
    requireBothSboms: boolean(raw.requireBothSboms, 'SBOM requirement'),
  };
  if (
    JSON.stringify(policy.requiredTargets) !==
      JSON.stringify(REQUIRED_TARGETS) ||
    !policy.requireProductionDetachedSignature ||
    !policy.requireBuildAttestation ||
    !policy.requireBothSboms
  ) {
    fail('required candidate safety control is disabled');
  }
  return policy;
}

export async function loadCandidatePolicy(
  root = REPOSITORY_ROOT,
): Promise<CandidatePolicy> {
  const { value } = await readJson(
    resolve(root, POLICY_PATH),
    65_536,
    'candidate policy',
  );
  const policy = parsePolicy(value);
  const { value: rootManifest } = await readJson(
    resolve(root, 'package.json'),
    1_048_576,
    'root manifest',
  );
  const { value: upgradePolicy } = await readJson(
    resolve(root, 'release/upgrade-policy.json'),
    65_536,
    'upgrade policy',
  );
  if (
    rootManifest.version !== policy.targetVersion ||
    upgradePolicy.targetVersion !== policy.targetVersion
  ) {
    fail('candidate, upgrade, and repository versions do not match');
  }
  return policy;
}

interface CheckRecord {
  id: string;
  status: CheckStatus;
  evidenceSha256: string | null;
}

function parseChecks(
  value: unknown,
  required: readonly string[],
  context: string,
): CheckRecord[] {
  if (!Array.isArray(value) || value.length !== required.length) {
    fail(`invalid ${context}`);
  }
  const checks = value.map((entry) => {
    if (!isObject(entry)) return fail(`invalid ${context} record`);
    exactKeys(entry, ['id', 'status', 'evidenceSha256'], `${context} record`);
    const id = text(entry.id, 64, `${context} id`);
    const status = oneOf(entry.status, CHECK_STATUSES, `${context} status`);
    const evidenceSha256 = optionalDigest(
      entry.evidenceSha256,
      `${context} evidence digest`,
    );
    if (status !== 'not-run' && evidenceSha256 === null) {
      fail(`completed ${context} needs retained evidence`);
    }
    if (status === 'not-run' && evidenceSha256 !== null) {
      fail(`unrun ${context} cannot claim evidence`);
    }
    return { id, status, evidenceSha256 };
  });
  if (
    JSON.stringify(checks.map((check) => check.id)) !== JSON.stringify(required)
  ) {
    fail(`${context} is incomplete or unordered`);
  }
  return checks;
}

interface ArtifactRecord {
  name: string;
  sha256: string;
  manifestSha256: string;
  sourceCommit: string;
  sboms: { cargo: string; npm: string };
  detachedSignature: {
    status: CheckStatus;
    keyEnvironment: 'test' | 'production' | null;
    keyId: string | null;
  };
  nativeSignature: {
    status: CheckStatus | 'not-required';
    identity: string | null;
  };
  attestation: { status: CheckStatus; digest: string | null };
}

function parseArtifact(value: unknown): ArtifactRecord | null {
  if (value === null) return null;
  if (!isObject(value)) fail('invalid candidate artifact');
  exactKeys(
    value,
    [
      'name',
      'sha256',
      'manifestSha256',
      'sourceCommit',
      'sboms',
      'detachedSignature',
      'nativeSignature',
      'attestation',
    ],
    'candidate artifact',
  );
  const sourceCommit = text(value.sourceCommit, 64, 'artifact source commit');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit)) {
    fail('invalid artifact source commit');
  }
  if (!isObject(value.sboms)) fail('invalid artifact SBOM evidence');
  exactKeys(value.sboms, ['cargo', 'npm'], 'artifact SBOM evidence');
  if (!isObject(value.detachedSignature))
    fail('invalid detached signature evidence');
  exactKeys(
    value.detachedSignature,
    ['status', 'keyEnvironment', 'keyId'],
    'detached signature evidence',
  );
  const detachedStatus = oneOf(
    value.detachedSignature.status,
    CHECK_STATUSES,
    'detached signature status',
  );
  const keyEnvironment =
    value.detachedSignature.keyEnvironment === null
      ? null
      : oneOf(
          value.detachedSignature.keyEnvironment,
          ['test', 'production'] as const,
          'key environment',
        );
  const keyId =
    value.detachedSignature.keyId === null
      ? null
      : text(value.detachedSignature.keyId, 71, 'signing key id');
  if (keyId !== null && !/^sha256:[0-9a-f]{64}$/.test(keyId)) {
    fail('invalid signing key id');
  }
  if (
    (detachedStatus === 'passed' &&
      (keyEnvironment === null || keyId === null)) ||
    (detachedStatus === 'not-run' &&
      (keyEnvironment !== null || keyId !== null))
  ) {
    fail('inconsistent detached signature evidence');
  }
  if (!isObject(value.nativeSignature))
    fail('invalid native signature evidence');
  exactKeys(
    value.nativeSignature,
    ['status', 'identity'],
    'native signature evidence',
  );
  const nativeStatus = oneOf(
    value.nativeSignature.status,
    [...CHECK_STATUSES, 'not-required'] as const,
    'native signature status',
  );
  const nativeIdentity =
    value.nativeSignature.identity === null
      ? null
      : text(value.nativeSignature.identity, 160, 'native signing identity');
  if (
    (nativeStatus === 'passed' && nativeIdentity === null) ||
    (['not-run', 'not-required'].includes(nativeStatus) &&
      nativeIdentity !== null)
  ) {
    fail('inconsistent native signature evidence');
  }
  if (!isObject(value.attestation)) fail('invalid attestation evidence');
  exactKeys(value.attestation, ['status', 'digest'], 'attestation evidence');
  const attestationStatus = oneOf(
    value.attestation.status,
    CHECK_STATUSES,
    'attestation status',
  );
  const attestationDigest = optionalDigest(
    value.attestation.digest,
    'attestation digest',
  );
  if (
    (attestationStatus === 'passed' && attestationDigest === null) ||
    (attestationStatus === 'not-run' && attestationDigest !== null)
  ) {
    fail('inconsistent attestation evidence');
  }
  return {
    name: text(value.name, 180, 'artifact name'),
    sha256: digest(value.sha256, 'artifact digest'),
    manifestSha256: digest(value.manifestSha256, 'manifest digest'),
    sourceCommit,
    sboms: {
      cargo: digest(value.sboms.cargo, 'Cargo SBOM digest'),
      npm: digest(value.sboms.npm, 'npm SBOM digest'),
    },
    detachedSignature: {
      status: detachedStatus,
      keyEnvironment,
      keyId,
    },
    nativeSignature: { status: nativeStatus, identity: nativeIdentity },
    attestation: { status: attestationStatus, digest: attestationDigest },
  };
}

interface ParsedTarget extends TargetIdentity {
  artifact: ArtifactRecord | null;
  checks: CheckRecord[];
}

function parseTargets(value: unknown, policy: CandidatePolicy): ParsedTarget[] {
  if (!Array.isArray(value) || value.length > policy.requiredTargets.length) {
    fail('invalid candidate targets');
  }
  const targets = value.map((entry) => {
    if (!isObject(entry)) return fail('invalid candidate target');
    exactKeys(
      entry,
      ['platform', 'arch', 'environment', 'artifact', 'checks'],
      'candidate target',
    );
    const platform = oneOf(entry.platform, PLATFORMS, 'candidate platform');
    const arch = oneOf(entry.arch, ARCHITECTURES, 'candidate architecture');
    if (!isObject(entry.environment)) fail('invalid target environment');
    exactKeys(
      entry.environment,
      ['os', 'osVersion', 'runnerImage', 'node', 'npm', 'rust', 'tauri'],
      'target environment',
    );
    for (const [name, field] of Object.entries(entry.environment)) {
      text(field, 160, `environment ${name}`);
    }
    const expectedOs = { linux: 'Linux', macos: 'macOS', windows: 'Windows' }[
      platform
    ];
    if (entry.environment.os !== expectedOs)
      fail('target operating system mismatch');
    return {
      platform,
      arch,
      artifact: parseArtifact(entry.artifact),
      checks: parseChecks(
        entry.checks,
        policy.requiredTargetChecks,
        'target checks',
      ),
    };
  });
  const keys = targets.map(targetKey);
  if (
    new Set(keys).size !== keys.length ||
    JSON.stringify(keys) !== JSON.stringify([...keys].sort()) ||
    keys.some(
      (key) =>
        !policy.requiredTargets.some((target) => targetKey(target) === key),
    )
  ) {
    fail('candidate targets must be supported, unique, and sorted');
  }
  return targets;
}

async function expectedLocks(root: string): Promise<Map<string, string>> {
  const locks = new Map<string, string>();
  for (const path of LOCK_PATHS) {
    const details = await lstat(resolve(root, path));
    if (!details.isFile() || details.isSymbolicLink() || details.size <= 0) {
      fail('dependency lock must be a regular file');
    }
    locks.set(path, sha256(await readFile(resolve(root, path))));
  }
  return locks;
}

export async function evaluateCandidate(
  policy: CandidatePolicy,
  evidence: JsonObject,
  expectedCommit: string,
  root = REPOSITORY_ROOT,
): Promise<CandidateDecision> {
  exactKeys(
    evidence,
    [
      'schemaVersion',
      'candidateId',
      'version',
      'channel',
      'commit',
      'sourceDateEpoch',
      'generatedAt',
      'locks',
      'globalChecks',
      'targets',
      'residualRisks',
      'decision',
    ],
    'candidate evidence',
  );
  if (evidence.schemaVersion !== 1) fail('unsupported candidate evidence');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedCommit)) {
    fail('expected commit must be a full lowercase object id');
  }
  const version = text(evidence.version, 64, 'candidate version');
  parseSemanticVersion(version);
  const channel = oneOf(evidence.channel, CHANNELS, 'candidate channel');
  const candidateId = text(evidence.candidateId, 100, 'candidate id');
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (
    !new RegExp(`^${escapedVersion}-${channel}\\.[1-9]\\d*$`).test(candidateId)
  ) {
    fail('candidate id does not match version and channel');
  }
  const commit = text(evidence.commit, 64, 'candidate commit');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    fail('invalid candidate commit');
  }
  const sourceDateEpoch = integer(
    evidence.sourceDateEpoch,
    946_684_800,
    4_102_444_800,
    'source date epoch',
  );
  const generatedAt = timestamp(
    evidence.generatedAt,
    'candidate generation time',
  );
  if (new Date(generatedAt).valueOf() < sourceDateEpoch * 1000) {
    fail('candidate generation predates its source epoch');
  }
  if (
    !Array.isArray(evidence.locks) ||
    evidence.locks.length !== LOCK_PATHS.length
  ) {
    fail('invalid candidate locks');
  }
  const locks = evidence.locks.map((entry) => {
    if (!isObject(entry)) return fail('invalid candidate lock');
    exactKeys(entry, ['path', 'sha256'], 'candidate lock');
    return {
      path: text(entry.path, 160, 'lock path'),
      sha256: digest(entry.sha256, 'lock digest'),
    };
  });
  if (
    JSON.stringify(locks.map((lock) => lock.path)) !==
    JSON.stringify(LOCK_PATHS)
  ) {
    fail('candidate locks are incomplete or unordered');
  }
  const globalChecks = parseChecks(
    evidence.globalChecks,
    policy.requiredGlobalChecks,
    'global checks',
  );
  const targets = parseTargets(evidence.targets, policy);
  if (
    !Array.isArray(evidence.residualRisks) ||
    evidence.residualRisks.length > policy.maxResidualRisks
  ) {
    fail('invalid residual risks');
  }
  const risks = evidence.residualRisks.map((entry) => {
    if (!isObject(entry)) return fail('invalid residual risk');
    exactKeys(
      entry,
      [
        'id',
        'severity',
        'status',
        'owner',
        'reviewBy',
        'summary',
        'mitigation',
      ],
      'residual risk',
    );
    const status = oneOf(entry.status, RISK_STATUSES, 'risk status');
    const owner =
      entry.owner === null ? null : text(entry.owner, 80, 'risk owner');
    const reviewBy =
      entry.reviewBy === null
        ? null
        : calendarDate(entry.reviewBy, 'risk review date');
    if (status === 'accepted' && (owner === null || reviewBy === null)) {
      fail('accepted risk needs an owner and review date');
    }
    return {
      id: text(entry.id, 80, 'risk id'),
      severity: oneOf(entry.severity, RISK_SEVERITIES, 'risk severity'),
      status,
      owner,
      reviewBy,
      summary: text(entry.summary, 300, 'risk summary'),
      mitigation: text(entry.mitigation, 500, 'risk mitigation'),
    };
  });
  if (new Set(risks.map((risk) => risk.id)).size !== risks.length) {
    fail('duplicate residual risk id');
  }
  if (!isObject(evidence.decision)) fail('invalid candidate decision');
  exactKeys(
    evidence.decision,
    ['status', 'decidedAt', 'decidedBy', 'rationale'],
    'candidate decision',
  );
  const declaredStatus = oneOf(
    evidence.decision.status,
    ['go', 'no-go'] as const,
    'candidate decision status',
  );
  const decidedAt = timestamp(evidence.decision.decidedAt, 'decision time');
  if (new Date(decidedAt).valueOf() < new Date(generatedAt).valueOf()) {
    fail('candidate decision predates evidence');
  }
  const decidedBy =
    evidence.decision.decidedBy === null
      ? null
      : text(evidence.decision.decidedBy, 80, 'decision actor');
  text(evidence.decision.rationale, 500, 'decision rationale');
  if (declaredStatus === 'go' && decidedBy === null) {
    fail('go decision requires an accountable actor');
  }
  const decisionDate = decidedAt.slice(0, 10);
  for (const risk of risks) {
    if (
      risk.status === 'accepted' &&
      risk.reviewBy !== null &&
      risk.reviewBy < decisionDate
    ) {
      fail(`accepted risk review is overdue: ${risk.id}`);
    }
  }

  const failures = new Set<string>();
  if (version !== policy.targetVersion) failures.add('version_mismatch');
  if (commit !== expectedCommit) failures.add('commit_mismatch');
  const actualLocks = await expectedLocks(root);
  for (const lock of locks) {
    if (actualLocks.get(lock.path) !== lock.sha256) {
      failures.add(`lock_mismatch:${lock.path}`);
    }
  }
  for (const check of globalChecks) {
    if (check.status !== 'passed')
      failures.add(`global_check:${check.id}:${check.status}`);
  }
  let targetsPassed = 0;
  for (const requiredTarget of policy.requiredTargets) {
    const key = targetKey(requiredTarget);
    const target = targets.find((candidate) => targetKey(candidate) === key);
    if (!target) {
      failures.add(`target_missing:${key}`);
      continue;
    }
    const before = failures.size;
    for (const check of target.checks) {
      if (check.status !== 'passed') {
        failures.add(`target_check:${key}:${check.id}:${check.status}`);
      }
    }
    const artifact = target.artifact;
    if (!artifact) {
      failures.add(`artifact_missing:${key}`);
    } else {
      if (!validArtifactName(artifact.name, version, channel, requiredTarget)) {
        failures.add(`artifact_name_mismatch:${key}`);
      }
      if (artifact.sourceCommit !== commit)
        failures.add(`artifact_commit_mismatch:${key}`);
      if (
        policy.requireProductionDetachedSignature &&
        (artifact.detachedSignature.status !== 'passed' ||
          artifact.detachedSignature.keyEnvironment !== 'production')
      ) {
        failures.add(`production_signature_missing:${key}`);
      }
      const needsNative = policy.requireNativeSignatureOn.includes(
        requiredTarget.platform,
      );
      if (
        (needsNative && artifact.nativeSignature.status !== 'passed') ||
        (!needsNative && artifact.nativeSignature.status !== 'not-required')
      ) {
        failures.add(`native_signature_mismatch:${key}`);
      }
      if (
        policy.requireBuildAttestation &&
        artifact.attestation.status !== 'passed'
      ) {
        failures.add(`attestation_missing:${key}`);
      }
    }
    if (failures.size === before) targetsPassed += 1;
  }
  for (const risk of risks) {
    if (risk.status === 'open') failures.add(`risk_open:${risk.id}`);
    if (
      risk.status === 'accepted' &&
      ['high', 'critical'].includes(risk.severity)
    ) {
      failures.add(`risk_too_high:${risk.id}`);
    }
  }
  const computedStatus = failures.size === 0 ? 'go' : 'no-go';
  if (declaredStatus !== computedStatus)
    failures.add('decision_status_mismatch');
  const finalStatus = failures.size === 0 ? 'go' : 'no-go';
  return {
    schemaVersion: 1,
    candidateId,
    version,
    commit,
    status: finalStatus,
    evidenceSha256: sha256(canonicalJson(evidence)),
    targetsPassed,
    targetsRequired: policy.requiredTargets.length,
    failures: [...failures].sort(),
  };
}

function options(args: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const argument of args) {
    const match = /^(--[a-z-]+)=(.+)$/.exec(argument);
    if (!match?.[1] || !match[2] || parsed.has(match[1])) {
      fail('invalid or duplicate option');
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
      fail('unsupported policy option');
    }
    const policy = await loadCandidatePolicy(root);
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, status: 'ok', version: policy.targetVersion, targets: policy.requiredTargets.length, globalChecks: policy.requiredGlobalChecks.length, targetChecks: policy.requiredTargetChecks.length, retentionDays: policy.retentionDays })}\n`,
    );
    return;
  }
  if (command !== 'validate') fail('expected policy or validate');
  for (const key of parsed.keys()) {
    if (
      !['--repository-root', '--evidence', '--expected-commit'].includes(key)
    ) {
      fail(`unsupported option: ${key}`);
    }
  }
  const evidencePath = parsed.get('--evidence');
  const expectedCommit = parsed.get('--expected-commit');
  if (!evidencePath || !expectedCommit)
    fail('missing candidate validation option');
  const policy = await loadCandidatePolicy(root);
  const { value } = await readJson(
    resolve(evidencePath),
    policy.maxEvidenceBytes,
    'candidate evidence',
  );
  const result = await evaluateCandidate(policy, value, expectedCommit, root);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'no-go') process.exitCode = 2;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof CandidateValidationError
        ? error.message
        : 'unexpected failure';
    process.stderr.write(`candidate_validation_failed: ${message}\n`);
    process.exitCode = 1;
  });
}
