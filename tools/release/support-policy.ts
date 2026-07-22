import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './artifact-bundle.js';
import { loadCandidatePolicy } from './candidate.js';
import { loadUpdatePolicy } from './update-recovery.js';
import { loadUpgradePolicy } from './upgrade.js';
import { compareSemanticVersions, parseSemanticVersion } from './versioning.js';

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const POLICY_PATH = 'release/support-policy.json';
const CHANNELS = ['stable', 'beta', 'nightly'] as const;
const PLATFORMS = ['linux', 'macos', 'windows'] as const;
const ARCHITECTURES = ['arm64', 'x64'] as const;
const BROWSERS = ['chrome', 'edge', 'firefox', 'safari'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const SUPPORTED_PACKAGES = {
  linux: ['AppImage', 'deb'],
  macos: ['app.tar.gz', 'dmg'],
  windows: ['msi', 'nsis.zip'],
} as const;
const ROLLING_CHECKS = [
  'authorization-revalidated',
  'event-identity-preserved',
  'http-continuity',
  'no-private-disclosure',
  'queue-backlog-recovered',
  'websocket-reconnect',
] as const;
const REQUIRED_CANDIDATE_CHECKS = [
  'compatibility-review',
  'rolling-upgrade',
] as const;

type JsonObject = Record<string, unknown>;
type Channel = (typeof CHANNELS)[number];
type Platform = (typeof PLATFORMS)[number];
type Architecture = (typeof ARCHITECTURES)[number];
type RollingCheck = (typeof ROLLING_CHECKS)[number];

interface DesktopEnvironment {
  platform: Platform;
  operatingSystem: string;
  minimum: string;
  architectures: Architecture[];
  packages: string[];
}

interface ChannelPolicy {
  productionEligible: boolean;
  minimumDaysFromPublication: number;
  daysAfterSuperseded: number;
  plannedEndOfSupportNoticeDays: number;
  fixPolicy: string;
  stability: string;
}

export interface SupportPolicy {
  schemaVersion: 1;
  product: 'nexa-chat';
  targetVersion: string;
  effectiveDate: string;
  productStatus: 'pre-release-no-supported-production-version';
  activationGate: 'release-candidate-go';
  environments: {
    web: {
      secureContextRequired: true;
      javascriptRequired: true;
      mobile: 'not-supported';
      browsers: Array<{
        family: (typeof BROWSERS)[number];
        minimum: string;
        scope: 'desktop';
      }>;
    };
    desktop: DesktopEnvironment[];
    server: {
      operatingSystems: Array<{
        name: string;
        minimum: string;
        architectures: Architecture[];
      }>;
      nodeRange: string;
      validatedNode: string;
      npmRange: string;
      validatedNpm: string;
    };
  };
  dependencies: {
    postgresql: {
      minimum: string;
      maximumExclusive: string;
      validatedImage: string;
      role: 'authoritative';
    };
    valkey: {
      minimum: string;
      maximumExclusive: string;
      validatedImage: string;
      role: 'optional-coordination-fail-closed';
    };
    objectStorage: {
      status: 'adapter-preview-not-product-connected';
      protocol: 'S3-compatible-HTTPS';
      validatedImage: string;
      role: 'authoritative-when-enabled';
    };
  };
  contracts: {
    httpVersions: number[];
    realtimeVersions: number[];
    configurationVersions: number[];
    databaseSchema: number;
    breakingVersionNoticeDays: number;
  };
  compatibility: {
    clientServer: Array<{
      clientVersion: string;
      serverVersion: string;
      status: 'candidate-only-until-activation';
    }>;
    rollingUpgrade: {
      sourceVersion: string;
      targetVersion: string;
      databaseSchema: number;
      configurationSchema: number;
      httpVersion: number;
      realtimeVersion: number;
      mode: 'same-version-no-schema-change';
      coordination: 'valkey';
      minimumInstances: number;
    };
    versionChangingRollingUpgrades: 'unsupported-until-listed-and-evidenced';
    schemaChangingRollingUpgrades: 'maintenance-and-old-instance-drain-required';
  };
  channels: Record<Channel, ChannelPolicy>;
  maintenance: {
    objectivesAreServiceLevelAgreements: false;
    securityResponseObjectives: Array<{
      severity: (typeof SEVERITIES)[number];
      initialResponseHours: number;
      mitigationTargetDays: number;
    }>;
    publicationLocations: string[];
    emergencyException: string;
  };
  review: {
    cadenceDays: number;
    canonicalDocument: 'docs/releases/support-compatibility.md';
    requiredCandidateChecks: string[];
    maximumRollingEvidenceBytes: number;
  };
}

interface RollingEndpoint {
  version: string;
  httpVersion: number;
  realtimeVersion: number;
  databaseSchema: number;
  configurationSchema: number;
}

interface RollingEvidence {
  schemaVersion: 1;
  scenarioId: string;
  commit: string;
  startedAt: string;
  completedAt: string;
  channel: Channel;
  source: RollingEndpoint;
  target: RollingEndpoint;
  topology: {
    oldInstances: number;
    newInstances: number;
    coordination: 'valkey' | 'local';
  };
  schemaChange: boolean;
  checks: Array<{
    id: RollingCheck;
    status: 'passed' | 'failed' | 'not-run';
    evidenceSha256: string | null;
  }>;
}

export interface RollingDecision {
  schemaVersion: 1;
  scenarioId: string;
  commit: string;
  status: 'supported' | 'rejected';
  evidenceSha256: string;
  failures: string[];
}

export class SupportPolicyError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'SupportPolicyError';
  }
}

function fail(code: string): never {
  throw new SupportPolicyError(code);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, context: string): JsonObject {
  if (!isObject(value)) fail(`invalid_${context}`);
  return value;
}

function exactKeys(value: JsonObject, keys: string[], context: string): void {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...keys].sort())
  ) {
    fail(`invalid_${context}`);
  }
}

function text(value: unknown, maximum: number, context: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\0\r\n]/.test(value)
  ) {
    fail(`invalid_${context}`);
  }
  return value;
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

function literal<T extends string | boolean | number>(
  value: unknown,
  expected: T,
  context: string,
): T {
  if (value !== expected) fail(`invalid_${context}`);
  return expected;
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

function semanticVersion(value: unknown, context: string): string {
  const parsed = text(value, 64, context);
  try {
    parseSemanticVersion(parsed);
  } catch {
    fail(`invalid_${context}`);
  }
  return parsed;
}

function fullCommit(value: unknown): string {
  const parsed = text(value, 64, 'commit');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parsed)) {
    fail('invalid_commit');
  }
  return parsed;
}

function timestamp(value: unknown, context: string): string {
  const parsed = text(value, 40, context);
  try {
    if (new Date(parsed).toISOString() !== parsed) fail(`invalid_${context}`);
  } catch {
    fail(`invalid_${context}`);
  }
  return parsed;
}

function calendarDate(value: unknown, context: string): string {
  const parsed = text(value, 10, context);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) fail(`invalid_${context}`);
  const date = new Date(`${parsed}T00:00:00.000Z`);
  if (date.toISOString().slice(0, 10) !== parsed) fail(`invalid_${context}`);
  return parsed;
}

function digest(value: unknown, context: string): string {
  const parsed = text(value, 64, context);
  if (!/^[0-9a-f]{64}$/.test(parsed)) fail(`invalid_${context}`);
  return parsed;
}

function orderedStrings(
  value: unknown,
  maximumEntries: number,
  context: string,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maximumEntries
  ) {
    fail(`invalid_${context}`);
  }
  const parsed = value.map((entry) => text(entry, 100, context));
  if (
    new Set(parsed).size !== parsed.length ||
    JSON.stringify(parsed) !== JSON.stringify([...parsed].sort())
  ) {
    fail(`invalid_${context}`);
  }
  return parsed;
}

function versionArray(value: unknown, context: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    fail(`invalid_${context}`);
  }
  const parsed = value.map((entry) => integer(entry, 1, 1_000_000, context));
  if (
    new Set(parsed).size !== parsed.length ||
    JSON.stringify(parsed) !==
      JSON.stringify([...parsed].sort((left, right) => left - right))
  ) {
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
  return object(parsed, context);
}

function validatePolicy(raw: JsonObject): SupportPolicy {
  exactKeys(
    raw,
    [
      'schemaVersion',
      'product',
      'targetVersion',
      'effectiveDate',
      'productStatus',
      'activationGate',
      'environments',
      'dependencies',
      'contracts',
      'compatibility',
      'channels',
      'maintenance',
      'review',
    ],
    'support_policy',
  );
  literal(raw.schemaVersion, 1, 'support_schema');
  literal(raw.product, 'nexa-chat', 'support_product');
  semanticVersion(raw.targetVersion, 'target_version');
  calendarDate(raw.effectiveDate, 'effective_date');
  literal(
    raw.productStatus,
    'pre-release-no-supported-production-version',
    'product_status',
  );
  literal(raw.activationGate, 'release-candidate-go', 'activation_gate');

  const environments = object(raw.environments, 'environments');
  exactKeys(environments, ['web', 'desktop', 'server'], 'environments');
  const web = object(environments.web, 'web_environment');
  exactKeys(
    web,
    ['secureContextRequired', 'javascriptRequired', 'mobile', 'browsers'],
    'web_environment',
  );
  literal(web.secureContextRequired, true, 'secure_context_requirement');
  literal(web.javascriptRequired, true, 'javascript_requirement');
  literal(web.mobile, 'not-supported', 'mobile_support');
  if (!Array.isArray(web.browsers) || web.browsers.length !== BROWSERS.length) {
    fail('invalid_browser_matrix');
  }
  const browserFamilies = web.browsers.map((entry) => {
    const browser = object(entry, 'browser');
    exactKeys(browser, ['family', 'minimum', 'scope'], 'browser');
    const family = oneOf(browser.family, BROWSERS, 'browser_family');
    const minimum = text(browser.minimum, 20, 'browser_minimum');
    if (!/^\d+(?:\.\d+)?$/.test(minimum)) fail('invalid_browser_minimum');
    literal(browser.scope, 'desktop', 'browser_scope');
    return family;
  });
  if (JSON.stringify(browserFamilies) !== JSON.stringify(BROWSERS)) {
    fail('invalid_browser_order');
  }

  if (
    !Array.isArray(environments.desktop) ||
    environments.desktop.length !== 3
  ) {
    fail('invalid_desktop_matrix');
  }
  const desktopPlatforms = environments.desktop.map((entry) => {
    const desktop = object(entry, 'desktop_environment');
    exactKeys(
      desktop,
      ['platform', 'operatingSystem', 'minimum', 'architectures', 'packages'],
      'desktop_environment',
    );
    const platform = oneOf(desktop.platform, PLATFORMS, 'desktop_platform');
    text(desktop.operatingSystem, 40, 'desktop_operating_system');
    text(desktop.minimum, 40, 'desktop_minimum');
    const architectures = orderedStrings(
      desktop.architectures,
      2,
      'desktop_architectures',
    );
    architectures.forEach((architecture) =>
      oneOf(architecture, ARCHITECTURES, 'desktop_architecture'),
    );
    const packages = orderedStrings(desktop.packages, 8, 'desktop_packages');
    if (
      JSON.stringify(packages) !== JSON.stringify(SUPPORTED_PACKAGES[platform])
    ) {
      fail('invalid_desktop_packages');
    }
    return platform;
  });
  if (JSON.stringify(desktopPlatforms) !== JSON.stringify(PLATFORMS)) {
    fail('invalid_desktop_order');
  }

  const server = object(environments.server, 'server_environment');
  exactKeys(
    server,
    [
      'operatingSystems',
      'nodeRange',
      'validatedNode',
      'npmRange',
      'validatedNpm',
    ],
    'server_environment',
  );
  if (
    !Array.isArray(server.operatingSystems) ||
    server.operatingSystems.length !== 1
  ) {
    fail('invalid_server_matrix');
  }
  for (const entry of server.operatingSystems) {
    const operatingSystem = object(entry, 'server_operating_system');
    exactKeys(
      operatingSystem,
      ['name', 'minimum', 'architectures'],
      'server_operating_system',
    );
    text(operatingSystem.name, 40, 'server_operating_system_name');
    text(operatingSystem.minimum, 40, 'server_operating_system_minimum');
    const architectures = orderedStrings(
      operatingSystem.architectures,
      2,
      'server_architectures',
    );
    architectures.forEach((architecture) =>
      oneOf(architecture, ARCHITECTURES, 'server_architecture'),
    );
  }
  text(server.nodeRange, 20, 'node_range');
  semanticVersion(server.validatedNode, 'validated_node');
  text(server.npmRange, 20, 'npm_range');
  semanticVersion(server.validatedNpm, 'validated_npm');

  const dependencies = object(raw.dependencies, 'dependencies');
  exactKeys(
    dependencies,
    ['postgresql', 'valkey', 'objectStorage'],
    'dependencies',
  );
  const postgresql = object(dependencies.postgresql, 'postgresql');
  exactKeys(
    postgresql,
    ['minimum', 'maximumExclusive', 'validatedImage', 'role'],
    'postgresql',
  );
  const postgresqlMinimum = semanticVersion(
    postgresql.minimum,
    'postgresql_minimum',
  );
  const postgresqlMaximum = semanticVersion(
    postgresql.maximumExclusive,
    'postgresql_maximum',
  );
  if (compareSemanticVersions(postgresqlMinimum, postgresqlMaximum) >= 0) {
    fail('invalid_postgresql_range');
  }
  text(postgresql.validatedImage, 80, 'postgresql_image');
  literal(postgresql.role, 'authoritative', 'postgresql_role');
  const valkey = object(dependencies.valkey, 'valkey');
  exactKeys(
    valkey,
    ['minimum', 'maximumExclusive', 'validatedImage', 'role'],
    'valkey',
  );
  const valkeyMinimum = semanticVersion(valkey.minimum, 'valkey_minimum');
  const valkeyMaximum = semanticVersion(
    valkey.maximumExclusive,
    'valkey_maximum',
  );
  if (compareSemanticVersions(valkeyMinimum, valkeyMaximum) >= 0) {
    fail('invalid_valkey_range');
  }
  text(valkey.validatedImage, 80, 'valkey_image');
  literal(valkey.role, 'optional-coordination-fail-closed', 'valkey_role');
  const objectStorage = object(dependencies.objectStorage, 'object_storage');
  exactKeys(
    objectStorage,
    ['status', 'protocol', 'validatedImage', 'role'],
    'object_storage',
  );
  literal(
    objectStorage.status,
    'adapter-preview-not-product-connected',
    'object_storage_status',
  );
  literal(
    objectStorage.protocol,
    'S3-compatible-HTTPS',
    'object_storage_protocol',
  );
  text(objectStorage.validatedImage, 100, 'object_storage_image');
  literal(
    objectStorage.role,
    'authoritative-when-enabled',
    'object_storage_role',
  );

  const contracts = object(raw.contracts, 'contracts');
  exactKeys(
    contracts,
    [
      'httpVersions',
      'realtimeVersions',
      'configurationVersions',
      'databaseSchema',
      'breakingVersionNoticeDays',
    ],
    'contracts',
  );
  versionArray(contracts.httpVersions, 'http_versions');
  versionArray(contracts.realtimeVersions, 'realtime_versions');
  versionArray(contracts.configurationVersions, 'configuration_versions');
  integer(contracts.databaseSchema, 1, 1_000_000, 'database_schema');
  integer(contracts.breakingVersionNoticeDays, 30, 3650, 'breaking_notice');

  const compatibility = object(raw.compatibility, 'compatibility');
  exactKeys(
    compatibility,
    [
      'clientServer',
      'rollingUpgrade',
      'versionChangingRollingUpgrades',
      'schemaChangingRollingUpgrades',
    ],
    'compatibility',
  );
  if (
    !Array.isArray(compatibility.clientServer) ||
    compatibility.clientServer.length === 0 ||
    compatibility.clientServer.length > 16
  ) {
    fail('invalid_client_server_matrix');
  }
  for (const entry of compatibility.clientServer) {
    const pair = object(entry, 'client_server_pair');
    exactKeys(
      pair,
      ['clientVersion', 'serverVersion', 'status'],
      'client_server_pair',
    );
    semanticVersion(pair.clientVersion, 'client_version');
    semanticVersion(pair.serverVersion, 'server_version');
    literal(
      pair.status,
      'candidate-only-until-activation',
      'client_server_status',
    );
  }
  const rolling = object(compatibility.rollingUpgrade, 'rolling_upgrade');
  exactKeys(
    rolling,
    [
      'sourceVersion',
      'targetVersion',
      'databaseSchema',
      'configurationSchema',
      'httpVersion',
      'realtimeVersion',
      'mode',
      'coordination',
      'minimumInstances',
    ],
    'rolling_upgrade',
  );
  semanticVersion(rolling.sourceVersion, 'rolling_source_version');
  semanticVersion(rolling.targetVersion, 'rolling_target_version');
  integer(rolling.databaseSchema, 1, 1_000_000, 'rolling_database_schema');
  integer(
    rolling.configurationSchema,
    1,
    1_000_000,
    'rolling_configuration_schema',
  );
  integer(rolling.httpVersion, 1, 1_000_000, 'rolling_http_version');
  integer(rolling.realtimeVersion, 1, 1_000_000, 'rolling_realtime_version');
  literal(rolling.mode, 'same-version-no-schema-change', 'rolling_mode');
  literal(rolling.coordination, 'valkey', 'rolling_coordination');
  integer(rolling.minimumInstances, 2, 32, 'rolling_instances');
  literal(
    compatibility.versionChangingRollingUpgrades,
    'unsupported-until-listed-and-evidenced',
    'version_changing_rolling_upgrades',
  );
  literal(
    compatibility.schemaChangingRollingUpgrades,
    'maintenance-and-old-instance-drain-required',
    'schema_changing_rolling_upgrades',
  );

  const channels = object(raw.channels, 'channels');
  exactKeys(channels, [...CHANNELS], 'channels');
  for (const name of CHANNELS) {
    const channel = object(channels[name], `${name}_channel`);
    exactKeys(
      channel,
      [
        'productionEligible',
        'minimumDaysFromPublication',
        'daysAfterSuperseded',
        'plannedEndOfSupportNoticeDays',
        'fixPolicy',
        'stability',
      ],
      `${name}_channel`,
    );
    literal(
      channel.productionEligible,
      name === 'stable',
      `${name}_production_eligibility`,
    );
    integer(
      channel.minimumDaysFromPublication,
      name === 'nightly' ? 1 : 30,
      3650,
      `${name}_minimum_window`,
    );
    integer(channel.daysAfterSuperseded, 0, 3650, `${name}_successor_window`);
    integer(
      channel.plannedEndOfSupportNoticeDays,
      0,
      3650,
      `${name}_notice_window`,
    );
    text(channel.fixPolicy, 100, `${name}_fix_policy`);
    text(channel.stability, 100, `${name}_stability`);
  }

  const maintenance = object(raw.maintenance, 'maintenance');
  exactKeys(
    maintenance,
    [
      'objectivesAreServiceLevelAgreements',
      'securityResponseObjectives',
      'publicationLocations',
      'emergencyException',
    ],
    'maintenance',
  );
  literal(
    maintenance.objectivesAreServiceLevelAgreements,
    false,
    'maintenance_sla_boundary',
  );
  if (
    !Array.isArray(maintenance.securityResponseObjectives) ||
    maintenance.securityResponseObjectives.length !== SEVERITIES.length
  ) {
    fail('invalid_security_response_matrix');
  }
  const severities = maintenance.securityResponseObjectives.map((entry) => {
    const objective = object(entry, 'security_response_objective');
    exactKeys(
      objective,
      ['severity', 'initialResponseHours', 'mitigationTargetDays'],
      'security_response_objective',
    );
    const severity = oneOf(objective.severity, SEVERITIES, 'severity');
    integer(objective.initialResponseHours, 1, 8760, 'initial_response_hours');
    integer(objective.mitigationTargetDays, 1, 3650, 'mitigation_days');
    return severity;
  });
  if (JSON.stringify(severities) !== JSON.stringify(SEVERITIES)) {
    fail('invalid_severity_order');
  }
  orderedStrings(maintenance.publicationLocations, 16, 'publication_locations');
  text(maintenance.emergencyException, 120, 'emergency_exception');

  const review = object(raw.review, 'review');
  exactKeys(
    review,
    [
      'cadenceDays',
      'canonicalDocument',
      'requiredCandidateChecks',
      'maximumRollingEvidenceBytes',
    ],
    'review',
  );
  integer(review.cadenceDays, 30, 365, 'review_cadence');
  literal(
    review.canonicalDocument,
    'docs/releases/support-compatibility.md',
    'canonical_document',
  );
  if (
    JSON.stringify(review.requiredCandidateChecks) !==
    JSON.stringify(REQUIRED_CANDIDATE_CHECKS)
  ) {
    fail('invalid_candidate_compatibility_checks');
  }
  integer(
    review.maximumRollingEvidenceBytes,
    4096,
    65_536,
    'maximum_rolling_evidence_bytes',
  );

  return structuredClone(raw) as unknown as SupportPolicy;
}

function targetKey(target: { platform: Platform; arch: Architecture }): string {
  return `${target.platform}/${target.arch}`;
}

function same(value: unknown, expected: unknown, code: string): void {
  if (JSON.stringify(value) !== JSON.stringify(expected)) fail(code);
}

async function verifyRepositoryAlignment(
  root: string,
  policy: SupportPolicy,
): Promise<void> {
  const [manifest, candidate, upgrade, update] = await Promise.all([
    readBoundedJson(resolve(root, 'package.json'), 1_048_576, 'root_manifest'),
    loadCandidatePolicy(root),
    loadUpgradePolicy(root),
    loadUpdatePolicy(root),
  ]);
  if (
    manifest.version !== policy.targetVersion ||
    candidate.targetVersion !== policy.targetVersion ||
    upgrade.targetVersion !== policy.targetVersion ||
    update.targetVersion !== policy.targetVersion
  ) {
    fail('support_version_drift');
  }
  const server = policy.environments.server;
  if (
    manifest.engines === undefined ||
    object(manifest.engines, 'root_engines').node !== server.nodeRange ||
    object(manifest.engines, 'root_engines').npm !== server.npmRange ||
    manifest.packageManager !== `npm@${server.validatedNpm}` ||
    (await readFile(resolve(root, '.node-version'), 'utf8')).trim() !==
      server.validatedNode
  ) {
    fail('support_toolchain_drift');
  }

  const desktopTargets = policy.environments.desktop.flatMap((environment) =>
    environment.architectures.map((arch) => ({
      platform: environment.platform,
      arch,
    })),
  );
  same(
    desktopTargets.map(targetKey).sort(),
    candidate.requiredTargets.map(targetKey).sort(),
    'candidate_target_drift',
  );
  same(
    desktopTargets.map(targetKey).sort(),
    update.platforms.map(targetKey).sort(),
    'update_target_drift',
  );
  for (const check of policy.review.requiredCandidateChecks) {
    if (!candidate.requiredGlobalChecks.includes(check)) {
      fail('candidate_compatibility_gate_missing');
    }
  }

  same(upgrade.channels, update.channels, 'release_channel_drift');
  if (
    upgrade.database.targetSchema !== policy.contracts.databaseSchema ||
    !policy.contracts.configurationVersions.includes(
      upgrade.configuration.targetSchema,
    )
  ) {
    fail('support_schema_drift');
  }
  const rolling = policy.compatibility.rollingUpgrade;
  if (
    rolling.sourceVersion !== rolling.targetVersion ||
    rolling.targetVersion !== policy.targetVersion ||
    !upgrade.supportedSourceVersions.includes(rolling.sourceVersion) ||
    rolling.databaseSchema !== upgrade.database.targetSchema ||
    rolling.configurationSchema !== upgrade.configuration.targetSchema ||
    !policy.contracts.httpVersions.includes(rolling.httpVersion) ||
    !policy.contracts.realtimeVersions.includes(rolling.realtimeVersion)
  ) {
    fail('rolling_policy_drift');
  }
  for (const pair of policy.compatibility.clientServer) {
    if (
      pair.clientVersion !== policy.targetVersion ||
      pair.serverVersion !== policy.targetVersion
    ) {
      fail('client_server_policy_drift');
    }
  }

  const [httpFixture, realtimeFixture] = await Promise.all([
    readBoundedJson(
      resolve(root, 'contracts/v1/http.json'),
      1_048_576,
      'http_contract_fixture',
    ),
    readBoundedJson(
      resolve(root, 'contracts/v1/realtime.json'),
      1_048_576,
      'realtime_contract_fixture',
    ),
  ]);
  if (
    !policy.contracts.httpVersions.includes(Number(httpFixture.version)) ||
    !policy.contracts.realtimeVersions.includes(Number(realtimeFixture.version))
  ) {
    fail('contract_fixture_drift');
  }

  const compose = await readFile(resolve(root, 'docker-compose.yml'), 'utf8');
  if (
    !compose.includes(
      `postgres:${policy.dependencies.postgresql.validatedImage}@sha256:`,
    ) ||
    !compose.includes(
      `valkey/valkey:${policy.dependencies.valkey.validatedImage}@sha256:`,
    ) ||
    !compose.includes(
      `chrislusf/seaweedfs:${policy.dependencies.objectStorage.validatedImage}@sha256:`,
    )
  ) {
    fail('dependency_baseline_drift');
  }

  const documentationChecks = [
    ['README.md', 'docs/releases/support-compatibility.md'],
    ['SECURITY.md', 'docs/releases/support-compatibility.md'],
    ['docs/releases/release-candidates.md', 'support-compatibility.md'],
  ] as const;
  for (const [path, marker] of documentationChecks) {
    if (!(await readFile(resolve(root, path), 'utf8')).includes(marker)) {
      fail('canonical_support_link_missing');
    }
  }
}

export async function loadSupportPolicy(
  root = REPOSITORY_ROOT,
): Promise<SupportPolicy> {
  const policy = validatePolicy(
    await readBoundedJson(resolve(root, POLICY_PATH), 65_536, 'support_policy'),
  );
  await verifyRepositoryAlignment(root, policy);
  return policy;
}

function rollingEndpoint(value: unknown, context: string): RollingEndpoint {
  const endpoint = object(value, context);
  exactKeys(
    endpoint,
    [
      'version',
      'httpVersion',
      'realtimeVersion',
      'databaseSchema',
      'configurationSchema',
    ],
    context,
  );
  return {
    version: semanticVersion(endpoint.version, `${context}_version`),
    httpVersion: integer(
      endpoint.httpVersion,
      1,
      1_000_000,
      `${context}_http_version`,
    ),
    realtimeVersion: integer(
      endpoint.realtimeVersion,
      1,
      1_000_000,
      `${context}_realtime_version`,
    ),
    databaseSchema: integer(
      endpoint.databaseSchema,
      1,
      1_000_000,
      `${context}_database_schema`,
    ),
    configurationSchema: integer(
      endpoint.configurationSchema,
      1,
      1_000_000,
      `${context}_configuration_schema`,
    ),
  };
}

function parseRollingEvidence(
  policy: SupportPolicy,
  value: unknown,
): RollingEvidence {
  if (
    Buffer.byteLength(canonicalJson(value)) >
    policy.review.maximumRollingEvidenceBytes
  ) {
    fail('rolling_evidence_too_large');
  }
  const evidence = object(value, 'rolling_evidence');
  exactKeys(
    evidence,
    [
      'schemaVersion',
      'scenarioId',
      'commit',
      'startedAt',
      'completedAt',
      'channel',
      'source',
      'target',
      'topology',
      'schemaChange',
      'checks',
    ],
    'rolling_evidence',
  );
  literal(evidence.schemaVersion, 1, 'rolling_schema');
  const scenarioId = text(evidence.scenarioId, 80, 'scenario_id');
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,78}[a-z0-9])?$/.test(scenarioId)) {
    fail('invalid_scenario_id');
  }
  const topology = object(evidence.topology, 'rolling_topology');
  exactKeys(
    topology,
    ['oldInstances', 'newInstances', 'coordination'],
    'rolling_topology',
  );
  if (
    !Array.isArray(evidence.checks) ||
    evidence.checks.length !== ROLLING_CHECKS.length
  ) {
    fail('invalid_rolling_checks');
  }
  const checks = evidence.checks.map((entry) => {
    const check = object(entry, 'rolling_check');
    exactKeys(check, ['id', 'status', 'evidenceSha256'], 'rolling_check');
    const id = oneOf(check.id, ROLLING_CHECKS, 'rolling_check_id');
    const status = oneOf(
      check.status,
      ['passed', 'failed', 'not-run'] as const,
      'rolling_check_status',
    );
    const evidenceSha256 =
      check.evidenceSha256 === null
        ? null
        : digest(check.evidenceSha256, 'rolling_check_digest');
    if ((status === 'not-run') !== (evidenceSha256 === null)) {
      fail('invalid_rolling_check_evidence');
    }
    return { id, status, evidenceSha256 };
  });
  if (
    JSON.stringify(checks.map((check) => check.id)) !==
    JSON.stringify(ROLLING_CHECKS)
  ) {
    fail('invalid_rolling_check_order');
  }
  return {
    schemaVersion: 1,
    scenarioId,
    commit: fullCommit(evidence.commit),
    startedAt: timestamp(evidence.startedAt, 'rolling_started_at'),
    completedAt: timestamp(evidence.completedAt, 'rolling_completed_at'),
    channel: oneOf(evidence.channel, CHANNELS, 'rolling_channel'),
    source: rollingEndpoint(evidence.source, 'rolling_source'),
    target: rollingEndpoint(evidence.target, 'rolling_target'),
    topology: {
      oldInstances: integer(
        topology.oldInstances,
        0,
        32,
        'rolling_old_instances',
      ),
      newInstances: integer(
        topology.newInstances,
        0,
        32,
        'rolling_new_instances',
      ),
      coordination: oneOf(
        topology.coordination,
        ['valkey', 'local'] as const,
        'rolling_evidence_coordination',
      ),
    },
    schemaChange:
      typeof evidence.schemaChange === 'boolean'
        ? evidence.schemaChange
        : fail('invalid_schema_change'),
    checks,
  };
}

export function evaluateRollingCompatibility(
  policy: SupportPolicy,
  value: unknown,
  expectedCommit: string,
): RollingDecision {
  const evidence = parseRollingEvidence(policy, value);
  const commit = fullCommit(expectedCommit);
  const failures: string[] = [];
  if (evidence.commit !== commit) failures.push('commit_mismatch');
  if (Date.parse(evidence.completedAt) < Date.parse(evidence.startedAt)) {
    failures.push('invalid_time_order');
  }
  const expected = policy.compatibility.rollingUpgrade;
  for (const [side, endpoint, version] of [
    ['source', evidence.source, expected.sourceVersion],
    ['target', evidence.target, expected.targetVersion],
  ] as const) {
    if (endpoint.version !== version) failures.push(`${side}_version_mismatch`);
    if (endpoint.httpVersion !== expected.httpVersion) {
      failures.push(`${side}_http_version_mismatch`);
    }
    if (endpoint.realtimeVersion !== expected.realtimeVersion) {
      failures.push(`${side}_realtime_version_mismatch`);
    }
    if (endpoint.databaseSchema !== expected.databaseSchema) {
      failures.push(`${side}_database_schema_mismatch`);
    }
    if (endpoint.configurationSchema !== expected.configurationSchema) {
      failures.push(`${side}_configuration_schema_mismatch`);
    }
  }
  if (evidence.schemaChange) failures.push('schema_change_unsupported');
  if (
    evidence.topology.oldInstances < 1 ||
    evidence.topology.newInstances < 1 ||
    evidence.topology.oldInstances + evidence.topology.newInstances <
      expected.minimumInstances
  ) {
    failures.push('rolling_topology_insufficient');
  }
  if (evidence.topology.coordination !== expected.coordination) {
    failures.push('coordination_mismatch');
  }
  for (const check of evidence.checks) {
    if (check.status !== 'passed')
      failures.push(`check_${check.status}:${check.id}`);
  }
  failures.sort();
  return {
    schemaVersion: 1,
    scenarioId: evidence.scenarioId,
    commit: evidence.commit,
    status: failures.length === 0 ? 'supported' : 'rejected',
    evidenceSha256: createHash('sha256')
      .update(canonicalJson(evidence))
      .digest('hex'),
    failures,
  };
}

function options(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const argument of args) {
    const match = /^(--[a-z-]+)=(.+)$/.exec(argument);
    if (!match?.[1] || !match[2] || result.has(match[1])) {
      fail('invalid_option');
    }
    result.set(match[1], match[2]);
  }
  return result;
}

async function main(args: string[]): Promise<void> {
  const [command, ...rawOptions] = args;
  const parsed = options(rawOptions);
  const root = parsed.get('--repository-root') ?? REPOSITORY_ROOT;
  const policy = await loadSupportPolicy(root);
  if (command === 'policy') {
    if ([...parsed.keys()].some((key) => key !== '--repository-root')) {
      fail('unsupported_policy_option');
    }
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, status: 'ok', version: policy.targetVersion, productStatus: policy.productStatus, browsers: policy.environments.web.browsers.length, desktopTargets: policy.environments.desktop.flatMap((entry) => entry.architectures).length, clientServerPairs: policy.compatibility.clientServer.length })}\n`,
    );
    return;
  }
  if (command !== 'rolling') fail('expected_policy_or_rolling');
  for (const key of parsed.keys()) {
    if (
      !['--repository-root', '--evidence', '--expected-commit'].includes(key)
    ) {
      fail('unsupported_rolling_option');
    }
  }
  const path = parsed.get('--evidence');
  const expectedCommit = parsed.get('--expected-commit');
  if (!path || !expectedCommit) fail('missing_rolling_option');
  const evidence = await readBoundedJson(
    resolve(path),
    policy.review.maximumRollingEvidenceBytes,
    'rolling_evidence',
  );
  const decision = evaluateRollingCompatibility(
    policy,
    evidence,
    expectedCommit,
  );
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  if (decision.status === 'rejected') process.exitCode = 2;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code =
      error instanceof SupportPolicyError ? error.code : 'unexpected_failure';
    process.stderr.write(`support_policy_failed: ${code}\n`);
    process.exitCode = 1;
  });
}
