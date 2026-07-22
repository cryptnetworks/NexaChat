import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_SCHEMA_VERSION } from '@nexa/postgres';
import { RUNTIME_CONFIGURATION_SCHEMA_VERSION } from '../../apps/server/src/config.js';
import { canonicalJson } from './artifact-bundle.js';
import { compareSemanticVersions, parseSemanticVersion } from './versioning.js';

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const POLICY_PATH = 'release/upgrade-policy.json';
const CHANNELS = ['stable', 'beta', 'nightly'] as const;
const REQUIRED_PROBES = [
  'audit',
  'authorization-http',
  'authorization-websocket',
  'background-jobs',
  'coordination',
  'object-storage',
] as const;

type Channel = (typeof CHANNELS)[number];
type Probe = (typeof REQUIRED_PROBES)[number];
type JsonObject = Record<string, unknown>;

export interface UpgradePolicy {
  schemaVersion: 1;
  product: 'nexa-chat';
  targetVersion: string;
  supportedSourceVersions: string[];
  cleanInstall: boolean;
  sameVersionRecovery: boolean;
  database: {
    minimumSourceSchema: number;
    targetSchema: number;
    migrationMode: 'transactional-forward-only';
    rollbackMode: 'verified-backup-restore-only';
  };
  configuration: {
    targetSchema: number;
    supportedSourceSchemas: number[];
    unknownKeys: 'reject';
  };
  channels: Record<Channel, Channel[]>;
  preflight: {
    maxEvidenceBytes: number;
    maxBackupAgeSeconds: number;
    minimumFreeSpaceMultiplier: number;
    requireVerifiedArtifact: boolean;
    requireMaintenanceForSchemaChange: boolean;
    requireDrainedOldInstances: boolean;
    requireQuiescentJobs: boolean;
  };
  postflight: {
    maximumErrorRateBasisPoints: number;
    requiredProbes: Probe[];
  };
}

export interface UpgradeDecision {
  schemaVersion: 1;
  phase: 'preflight' | 'postflight';
  status: 'accepted' | 'rejected';
  targetVersion: string;
  planId: string;
  checks: number;
  failures: string[];
}

export class UpgradeValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UpgradeValidationError';
  }
}

function fail(message: string): never {
  throw new UpgradeValidationError(message);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: JsonObject,
  expected: string[],
  context: string,
): void {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    fail(`unexpected ${context} fields`);
  }
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

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') fail(`invalid ${context}`);
  return value;
}

function isoTimestamp(value: unknown, context: string): string {
  const parsed = text(value, 40, context);
  try {
    if (new Date(parsed).toISOString() !== parsed) fail(`invalid ${context}`);
  } catch {
    fail(`invalid ${context}`);
  }
  return parsed;
}

function channel(value: unknown, context: string): Channel {
  if (typeof value !== 'string' || !CHANNELS.includes(value as Channel)) {
    fail(`invalid ${context}`);
  }
  return value as Channel;
}

function parsePolicy(raw: JsonObject): UpgradePolicy {
  exactKeys(
    raw,
    [
      'schemaVersion',
      'product',
      'targetVersion',
      'supportedSourceVersions',
      'cleanInstall',
      'sameVersionRecovery',
      'database',
      'configuration',
      'channels',
      'preflight',
      'postflight',
    ],
    'policy',
  );
  if (raw.schemaVersion !== 1 || raw.product !== 'nexa-chat') {
    fail('unsupported upgrade policy');
  }
  const targetVersion = text(raw.targetVersion, 64, 'target version');
  parseSemanticVersion(targetVersion);
  if (
    !Array.isArray(raw.supportedSourceVersions) ||
    raw.supportedSourceVersions.length === 0 ||
    raw.supportedSourceVersions.length > 16
  ) {
    fail('invalid supported source versions');
  }
  const supportedSourceVersions = raw.supportedSourceVersions.map((value) => {
    const version = text(value, 64, 'source version');
    parseSemanticVersion(version);
    if (compareSemanticVersions(version, targetVersion) > 0) {
      fail('source version is newer than target');
    }
    return version;
  });
  if (
    new Set(supportedSourceVersions).size !== supportedSourceVersions.length ||
    JSON.stringify(supportedSourceVersions) !==
      JSON.stringify([...supportedSourceVersions].sort(compareSemanticVersions))
  ) {
    fail('source versions must be unique and sorted');
  }
  if (!isObject(raw.database)) fail('invalid database policy');
  exactKeys(
    raw.database,
    ['minimumSourceSchema', 'targetSchema', 'migrationMode', 'rollbackMode'],
    'database policy',
  );
  const minimumSourceSchema = integer(
    raw.database.minimumSourceSchema,
    0,
    100_000,
    'minimum source schema',
  );
  const targetSchema = integer(
    raw.database.targetSchema,
    minimumSourceSchema,
    100_000,
    'target schema',
  );
  if (
    raw.database.migrationMode !== 'transactional-forward-only' ||
    raw.database.rollbackMode !== 'verified-backup-restore-only'
  ) {
    fail('unsupported database policy');
  }
  if (!isObject(raw.configuration)) fail('invalid configuration policy');
  exactKeys(
    raw.configuration,
    ['targetSchema', 'supportedSourceSchemas', 'unknownKeys'],
    'configuration policy',
  );
  const targetConfigurationSchema = integer(
    raw.configuration.targetSchema,
    1,
    1_000,
    'target configuration schema',
  );
  if (
    !Array.isArray(raw.configuration.supportedSourceSchemas) ||
    raw.configuration.supportedSourceSchemas.length === 0 ||
    raw.configuration.supportedSourceSchemas.length > 16 ||
    raw.configuration.unknownKeys !== 'reject'
  ) {
    fail('invalid configuration policy');
  }
  const supportedSourceSchemas = raw.configuration.supportedSourceSchemas.map(
    (value) =>
      integer(
        value,
        1,
        targetConfigurationSchema,
        'source configuration schema',
      ),
  );
  if (
    new Set(supportedSourceSchemas).size !== supportedSourceSchemas.length ||
    JSON.stringify(supportedSourceSchemas) !==
      JSON.stringify(
        [...supportedSourceSchemas].sort((left, right) => left - right),
      )
  ) {
    fail('configuration schemas must be unique and sorted');
  }
  if (!isObject(raw.channels)) fail('invalid channel policy');
  const channelPolicy = raw.channels;
  exactKeys(channelPolicy, [...CHANNELS], 'channel policy');
  const channels = Object.fromEntries(
    CHANNELS.map((target) => {
      const values = channelPolicy[target];
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.length > CHANNELS.length
      ) {
        fail('invalid channel path');
      }
      const parsed = values.map((value) => channel(value, 'source channel'));
      if (new Set(parsed).size !== parsed.length)
        fail('duplicate channel path');
      return [target, parsed];
    }),
  ) as Record<Channel, Channel[]>;
  if (!isObject(raw.preflight)) fail('invalid preflight policy');
  exactKeys(
    raw.preflight,
    [
      'maxEvidenceBytes',
      'maxBackupAgeSeconds',
      'minimumFreeSpaceMultiplier',
      'requireVerifiedArtifact',
      'requireMaintenanceForSchemaChange',
      'requireDrainedOldInstances',
      'requireQuiescentJobs',
    ],
    'preflight policy',
  );
  if (!isObject(raw.postflight)) fail('invalid postflight policy');
  exactKeys(
    raw.postflight,
    ['maximumErrorRateBasisPoints', 'requiredProbes'],
    'postflight policy',
  );
  if (
    !Array.isArray(raw.postflight.requiredProbes) ||
    JSON.stringify(raw.postflight.requiredProbes) !==
      JSON.stringify(REQUIRED_PROBES)
  ) {
    fail('required postflight probes are incomplete or unordered');
  }
  const policy: UpgradePolicy = {
    schemaVersion: 1,
    product: 'nexa-chat',
    targetVersion,
    supportedSourceVersions,
    cleanInstall: boolean(raw.cleanInstall, 'clean install policy'),
    sameVersionRecovery: boolean(
      raw.sameVersionRecovery,
      'same-version recovery policy',
    ),
    database: {
      minimumSourceSchema,
      targetSchema,
      migrationMode: 'transactional-forward-only',
      rollbackMode: 'verified-backup-restore-only',
    },
    configuration: {
      targetSchema: targetConfigurationSchema,
      supportedSourceSchemas,
      unknownKeys: 'reject',
    },
    channels,
    preflight: {
      maxEvidenceBytes: integer(
        raw.preflight.maxEvidenceBytes,
        1_024,
        1_048_576,
        'maximum evidence bytes',
      ),
      maxBackupAgeSeconds: integer(
        raw.preflight.maxBackupAgeSeconds,
        60,
        604_800,
        'maximum backup age',
      ),
      minimumFreeSpaceMultiplier: integer(
        raw.preflight.minimumFreeSpaceMultiplier,
        1,
        10,
        'free space multiplier',
      ),
      requireVerifiedArtifact: boolean(
        raw.preflight.requireVerifiedArtifact,
        'artifact requirement',
      ),
      requireMaintenanceForSchemaChange: boolean(
        raw.preflight.requireMaintenanceForSchemaChange,
        'maintenance requirement',
      ),
      requireDrainedOldInstances: boolean(
        raw.preflight.requireDrainedOldInstances,
        'drain requirement',
      ),
      requireQuiescentJobs: boolean(
        raw.preflight.requireQuiescentJobs,
        'job requirement',
      ),
    },
    postflight: {
      maximumErrorRateBasisPoints: integer(
        raw.postflight.maximumErrorRateBasisPoints,
        0,
        10_000,
        'maximum error rate',
      ),
      requiredProbes: [...REQUIRED_PROBES],
    },
  };
  if (
    !policy.cleanInstall ||
    !policy.sameVersionRecovery ||
    policy.preflight.maxEvidenceBytes > 32_768 ||
    policy.preflight.maxBackupAgeSeconds > 86_400 ||
    policy.preflight.minimumFreeSpaceMultiplier < 2 ||
    !policy.preflight.requireVerifiedArtifact ||
    !policy.preflight.requireMaintenanceForSchemaChange ||
    !policy.preflight.requireDrainedOldInstances ||
    !policy.preflight.requireQuiescentJobs ||
    policy.postflight.maximumErrorRateBasisPoints > 100 ||
    JSON.stringify(policy.channels) !==
      JSON.stringify({
        stable: ['stable'],
        beta: ['stable', 'beta'],
        nightly: ['nightly'],
      })
  ) {
    fail('required upgrade safety control is disabled');
  }
  return policy;
}

async function readJson(
  path: string,
  maxBytes: number,
  context: string,
): Promise<JsonObject> {
  const details = await lstat(path);
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size <= 0 ||
    details.size > maxBytes
  ) {
    fail(`${context} must be a bounded regular file`);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fail(`${context} is not valid JSON`);
  }
  if (!isObject(value)) fail(`${context} must be a JSON object`);
  return value;
}

export async function loadUpgradePolicy(
  root = REPOSITORY_ROOT,
): Promise<UpgradePolicy> {
  const policy = parsePolicy(
    await readJson(resolve(root, POLICY_PATH), 65_536, 'upgrade policy'),
  );
  const rootManifest = await readJson(
    resolve(root, 'package.json'),
    1_048_576,
    'root manifest',
  );
  if (rootManifest.version !== policy.targetVersion) {
    fail('upgrade target does not match repository version');
  }
  if (policy.database.targetSchema !== CURRENT_SCHEMA_VERSION) {
    fail('upgrade target does not match compiled database schema');
  }
  if (
    policy.configuration.targetSchema !== RUNTIME_CONFIGURATION_SCHEMA_VERSION
  ) {
    fail('upgrade target does not match runtime configuration schema');
  }
  const migrationNames = (
    await readdir(resolve(root, 'apps/server/migrations'))
  )
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (migrationNames.length !== policy.database.targetSchema) {
    fail('upgrade policy does not match migration count');
  }
  for (const [index, name] of migrationNames.entries()) {
    if (Number(name.slice(0, 4)) !== index + 1) {
      fail('migration history is not contiguous');
    }
  }
  return policy;
}

function decision(
  phase: UpgradeDecision['phase'],
  targetVersion: string,
  policy: UpgradePolicy,
  evidence: JsonObject,
  failures: Set<string>,
  checks: number,
): UpgradeDecision {
  return {
    schemaVersion: 1,
    phase,
    status: failures.size === 0 ? 'accepted' : 'rejected',
    targetVersion,
    planId: createHash('sha256')
      .update(canonicalJson({ policy, evidence }))
      .digest('hex'),
    checks,
    failures: [...failures].sort(),
  };
}

export function evaluatePreflight(
  policy: UpgradePolicy,
  evidence: JsonObject,
): UpgradeDecision {
  exactKeys(
    evidence,
    [
      'schemaVersion',
      'phase',
      'evaluatedAt',
      'sourceVersion',
      'targetVersion',
      'sourceChannel',
      'targetChannel',
      'databaseSchema',
      'configurationSchema',
      'backup',
      'space',
      'artifact',
      'maintenance',
      'dependencies',
    ],
    'preflight evidence',
  );
  if (evidence.schemaVersion !== 1 || evidence.phase !== 'preflight') {
    fail('unsupported preflight evidence');
  }
  const evaluatedAt = isoTimestamp(
    evidence.evaluatedAt,
    'evaluation timestamp',
  );
  const targetVersion = text(evidence.targetVersion, 64, 'target version');
  parseSemanticVersion(targetVersion);
  const targetChannel = channel(evidence.targetChannel, 'target channel');
  const sourceVersion =
    evidence.sourceVersion === null
      ? null
      : text(evidence.sourceVersion, 64, 'source version');
  if (sourceVersion) parseSemanticVersion(sourceVersion);
  const sourceChannel =
    evidence.sourceChannel === null
      ? null
      : channel(evidence.sourceChannel, 'source channel');
  const databaseSchema = integer(
    evidence.databaseSchema,
    0,
    100_000,
    'database schema',
  );
  const configurationSchema = integer(
    evidence.configurationSchema,
    0,
    1_000,
    'configuration schema',
  );
  if (!isObject(evidence.backup)) fail('invalid backup evidence');
  exactKeys(
    evidence.backup,
    ['status', 'verifiedAt', 'restoreTestId'],
    'backup evidence',
  );
  const backupStatus = text(evidence.backup.status, 20, 'backup status');
  if (!['verified', 'not-required'].includes(backupStatus)) {
    fail('invalid backup status');
  }
  const backupVerifiedAt =
    evidence.backup.verifiedAt === null
      ? null
      : isoTimestamp(evidence.backup.verifiedAt, 'backup timestamp');
  const restoreTestId =
    evidence.backup.restoreTestId === null
      ? null
      : text(evidence.backup.restoreTestId, 128, 'restore test id');
  if (restoreTestId && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(restoreTestId)) {
    fail('invalid restore test id');
  }
  if (!isObject(evidence.space)) fail('invalid space evidence');
  exactKeys(
    evidence.space,
    ['availableBytes', 'estimatedInstallBytes', 'estimatedDatabaseGrowthBytes'],
    'space evidence',
  );
  const availableBytes = integer(
    evidence.space.availableBytes,
    0,
    Number.MAX_SAFE_INTEGER,
    'available bytes',
  );
  const estimatedInstallBytes = integer(
    evidence.space.estimatedInstallBytes,
    1,
    Number.MAX_SAFE_INTEGER,
    'estimated install bytes',
  );
  const estimatedDatabaseGrowthBytes = integer(
    evidence.space.estimatedDatabaseGrowthBytes,
    0,
    Number.MAX_SAFE_INTEGER,
    'estimated database growth bytes',
  );
  if (!isObject(evidence.artifact)) fail('invalid artifact evidence');
  exactKeys(evidence.artifact, ['verified', 'commit'], 'artifact evidence');
  const artifactVerified = boolean(
    evidence.artifact.verified,
    'artifact verification',
  );
  const commit = text(evidence.artifact.commit, 64, 'artifact commit');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    fail('invalid artifact commit');
  }
  if (!isObject(evidence.maintenance)) fail('invalid maintenance evidence');
  exactKeys(
    evidence.maintenance,
    ['enabled', 'activeOldVersionInstances', 'runningJobs'],
    'maintenance evidence',
  );
  const maintenanceEnabled = boolean(
    evidence.maintenance.enabled,
    'maintenance state',
  );
  const activeOldVersionInstances = integer(
    evidence.maintenance.activeOldVersionInstances,
    0,
    100_000,
    'old instance count',
  );
  const runningJobs = integer(
    evidence.maintenance.runningJobs,
    0,
    1_000_000,
    'running job count',
  );
  if (!isObject(evidence.dependencies)) fail('invalid dependency evidence');
  exactKeys(
    evidence.dependencies,
    ['postgres', 'objectStorage', 'coordination'],
    'dependency evidence',
  );
  const postgres = text(evidence.dependencies.postgres, 16, 'PostgreSQL state');
  const objectStorage = text(
    evidence.dependencies.objectStorage,
    16,
    'object storage state',
  );
  const coordination = text(
    evidence.dependencies.coordination,
    16,
    'coordination state',
  );
  if (
    !['ready', 'failed'].includes(postgres) ||
    !['ready', 'disabled', 'failed'].includes(objectStorage) ||
    !['ready', 'disabled', 'failed'].includes(coordination)
  ) {
    fail('invalid dependency state');
  }

  const failures = new Set<string>();
  let checks = 0;
  const check = (condition: boolean, code: string): void => {
    checks += 1;
    if (!condition) failures.add(code);
  };
  check(targetVersion === policy.targetVersion, 'target_version_mismatch');
  check(
    databaseSchema <= policy.database.targetSchema,
    'database_schema_ahead',
  );
  check(
    databaseSchema >= policy.database.minimumSourceSchema,
    'database_schema_too_old',
  );
  check(
    policy.configuration.supportedSourceSchemas.includes(configurationSchema),
    'configuration_schema_unsupported',
  );
  check(artifactVerified, 'artifact_not_verified');
  const requiredSpace =
    (estimatedInstallBytes + estimatedDatabaseGrowthBytes) *
    policy.preflight.minimumFreeSpaceMultiplier;
  check(
    Number.isSafeInteger(requiredSpace) && availableBytes >= requiredSpace,
    'insufficient_space',
  );
  check(postgres === 'ready', 'postgres_unavailable');
  check(objectStorage !== 'failed', 'object_storage_unavailable');
  check(coordination !== 'failed', 'coordination_unavailable');
  check(
    !policy.preflight.requireDrainedOldInstances ||
      activeOldVersionInstances === 0,
    'old_instances_not_drained',
  );
  check(
    !policy.preflight.requireQuiescentJobs || runningJobs === 0,
    'jobs_not_quiescent',
  );
  const schemaChanges = databaseSchema !== policy.database.targetSchema;
  check(
    !schemaChanges ||
      !policy.preflight.requireMaintenanceForSchemaChange ||
      maintenanceEnabled,
    'maintenance_required',
  );
  if (sourceVersion === null) {
    check(policy.cleanInstall, 'clean_install_unsupported');
    check(sourceChannel === null, 'clean_install_source_channel_present');
    check(databaseSchema === 0, 'clean_install_database_not_empty');
    check(backupStatus === 'not-required', 'clean_install_backup_invalid');
  } else {
    check(
      policy.supportedSourceVersions.includes(sourceVersion),
      'source_version_unsupported',
    );
    check(
      sourceVersion !== targetVersion || policy.sameVersionRecovery,
      'same_version_recovery_unsupported',
    );
    check(
      sourceChannel !== null &&
        policy.channels[targetChannel].includes(sourceChannel),
      'channel_path_unsupported',
    );
    check(backupStatus === 'verified', 'verified_backup_required');
    check(
      backupVerifiedAt !== null &&
        new Date(evaluatedAt).valueOf() -
          new Date(backupVerifiedAt).valueOf() >=
          0 &&
        new Date(evaluatedAt).valueOf() -
          new Date(backupVerifiedAt).valueOf() <=
          policy.preflight.maxBackupAgeSeconds * 1000,
      'backup_stale',
    );
    check(restoreTestId !== null, 'restore_test_required');
  }
  return decision(
    'preflight',
    targetVersion,
    policy,
    evidence,
    failures,
    checks,
  );
}

export function evaluatePostflight(
  policy: UpgradePolicy,
  evidence: JsonObject,
  expectedPreflightPlanId: string,
): UpgradeDecision {
  exactKeys(
    evidence,
    [
      'schemaVersion',
      'phase',
      'preflightPlanId',
      'evaluatedAt',
      'targetVersion',
      'targetChannel',
      'commit',
      'databaseSchema',
      'configurationSchema',
      'ready',
      'migrationHistoryVerified',
      'artifactVerified',
      'probes',
      'errorRateBasisPoints',
      'rollbackCheckpointRetained',
    ],
    'postflight evidence',
  );
  if (evidence.schemaVersion !== 1 || evidence.phase !== 'postflight') {
    fail('unsupported postflight evidence');
  }
  if (!/^[0-9a-f]{64}$/.test(expectedPreflightPlanId)) {
    fail('invalid expected preflight plan id');
  }
  const preflightPlanId = text(
    evidence.preflightPlanId,
    64,
    'preflight plan id',
  );
  if (!/^[0-9a-f]{64}$/.test(preflightPlanId)) {
    fail('invalid preflight plan id');
  }
  isoTimestamp(evidence.evaluatedAt, 'evaluation timestamp');
  const targetVersion = text(evidence.targetVersion, 64, 'target version');
  parseSemanticVersion(targetVersion);
  channel(evidence.targetChannel, 'target channel');
  const commit = text(evidence.commit, 64, 'artifact commit');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    fail('invalid artifact commit');
  }
  const databaseSchema = integer(
    evidence.databaseSchema,
    0,
    100_000,
    'database schema',
  );
  const configurationSchema = integer(
    evidence.configurationSchema,
    0,
    1_000,
    'configuration schema',
  );
  const ready = boolean(evidence.ready, 'readiness');
  const migrationHistoryVerified = boolean(
    evidence.migrationHistoryVerified,
    'migration history verification',
  );
  const artifactVerified = boolean(
    evidence.artifactVerified,
    'artifact verification',
  );
  const rollbackCheckpointRetained = boolean(
    evidence.rollbackCheckpointRetained,
    'rollback checkpoint',
  );
  const errorRateBasisPoints = integer(
    evidence.errorRateBasisPoints,
    0,
    10_000,
    'error rate',
  );
  if (!isObject(evidence.probes)) fail('invalid postflight probes');
  const probeEvidence = evidence.probes;
  exactKeys(probeEvidence, [...REQUIRED_PROBES], 'postflight probes');
  const probes = Object.fromEntries(
    REQUIRED_PROBES.map((probe) => [
      probe,
      boolean(probeEvidence[probe], `${probe} probe`),
    ]),
  ) as Record<Probe, boolean>;

  const failures = new Set<string>();
  let checks = 0;
  const check = (condition: boolean, code: string): void => {
    checks += 1;
    if (!condition) failures.add(code);
  };
  check(targetVersion === policy.targetVersion, 'target_version_mismatch');
  check(preflightPlanId === expectedPreflightPlanId, 'preflight_plan_mismatch');
  check(
    databaseSchema === policy.database.targetSchema,
    'database_schema_mismatch',
  );
  check(
    configurationSchema === policy.configuration.targetSchema,
    'configuration_schema_mismatch',
  );
  check(ready, 'readiness_failed');
  check(migrationHistoryVerified, 'migration_history_unverified');
  check(artifactVerified, 'artifact_not_verified');
  check(
    errorRateBasisPoints <= policy.postflight.maximumErrorRateBasisPoints,
    'error_budget_exceeded',
  );
  check(rollbackCheckpointRetained, 'rollback_checkpoint_missing');
  for (const probe of policy.postflight.requiredProbes) {
    check(probes[probe], `probe_failed:${probe}`);
  }
  return decision(
    'postflight',
    targetVersion,
    policy,
    evidence,
    failures,
    checks,
  );
}

function parseOptions(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (const argument of args) {
    const match = /^(--[a-z-]+)=(.+)$/.exec(argument);
    if (!match?.[1] || !match[2] || options.has(match[1])) {
      fail('invalid or duplicate option');
    }
    options.set(match[1], match[2]);
  }
  return options;
}

async function main(args: string[]): Promise<void> {
  const [command, ...rawOptions] = args;
  const options = parseOptions(rawOptions);
  const repositoryRoot = options.get('--repository-root') ?? REPOSITORY_ROOT;
  const allowed = new Set(
    command === 'policy'
      ? ['--repository-root']
      : command === 'postflight'
        ? ['--repository-root', '--evidence', '--preflight-evidence']
        : ['--repository-root', '--evidence'],
  );
  for (const option of options.keys()) {
    if (!allowed.has(option)) fail(`unsupported option: ${option}`);
  }
  const policy = await loadUpgradePolicy(repositoryRoot);
  if (command === 'policy') {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, status: 'ok', targetVersion: policy.targetVersion, databaseSchema: policy.database.targetSchema, configurationSchema: policy.configuration.targetSchema, supportedSources: policy.supportedSourceVersions.length })}\n`,
    );
    return;
  }
  if (command !== 'preflight' && command !== 'postflight') {
    fail('expected policy, preflight, or postflight');
  }
  const evidencePath = options.get('--evidence');
  if (!evidencePath) fail('missing --evidence');
  const evidence = await readJson(
    resolve(evidencePath),
    policy.preflight.maxEvidenceBytes,
    'upgrade evidence',
  );
  const result =
    command === 'preflight'
      ? evaluatePreflight(policy, evidence)
      : await (async () => {
          const preflightEvidencePath = options.get('--preflight-evidence');
          if (!preflightEvidencePath) fail('missing --preflight-evidence');
          const preflightEvidence = await readJson(
            resolve(preflightEvidencePath),
            policy.preflight.maxEvidenceBytes,
            'preflight evidence',
          );
          const preflight = evaluatePreflight(policy, preflightEvidence);
          if (preflight.status !== 'accepted') {
            fail('preflight evidence is not accepted');
          }
          return evaluatePostflight(policy, evidence, preflight.planId);
        })();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'rejected') process.exitCode = 2;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof UpgradeValidationError
        ? error.message
        : 'unexpected failure';
    process.stderr.write(`upgrade_validation_failed: ${message}\n`);
    process.exitCode = 1;
  });
}
