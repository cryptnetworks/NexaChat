import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hasCompleteSqlStatement,
  isApprovedLicenseExpression,
} from './security-policy-helpers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(
  await readFile(join(root, 'security-policy.json'), 'utf8'),
);
const failures = [];
const fail = (message) => failures.push(message);

if (policy.schemaVersion !== 1) fail('unsupported security policy version');
if (!policy.owner?.startsWith('@')) fail('security policy owner is missing');
const reviewedAt = Date.parse(policy.reviewedAt);
const reviewAfter = Date.parse(policy.reviewAfter);
if (!Number.isFinite(reviewedAt) || !Number.isFinite(reviewAfter))
  fail('security policy review dates are invalid');
if (reviewAfter <= reviewedAt) fail('security policy review window is invalid');
if (Date.now() > reviewAfter) fail('security policy review is overdue');
if (policy.thresholds?.dependencies !== 'high')
  fail('dependency threshold must block HIGH findings');
if (policy.thresholds?.containers !== 'high')
  fail('container threshold must block HIGH findings');
if (policy.thresholds?.secrets !== 'any')
  fail('secret scan must block every finding');
if (policy.thresholds?.staticAnalysis !== 'error')
  fail('static analysis must block ERROR findings');

for (const [index, suppression] of (policy.suppressions ?? []).entries()) {
  if (!suppression.id || !suppression.owner || !suppression.rationale)
    fail(`suppression ${index} lacks an owner or rationale`);
  if (!suppression.compensatingControl)
    fail(`suppression ${index} lacks a compensating control`);
  if (!Number.isFinite(Date.parse(suppression.reviewAfter)))
    fail(`suppression ${index} lacks a review date`);
  if (Date.now() > Date.parse(suppression.reviewAfter))
    fail(`suppression ${index} is overdue for review`);
}

const gitleaksSuppressions = (policy.suppressions ?? []).filter(
  (suppression) => suppression.scanner === 'gitleaks',
);
const expectedGitleaksSuppression = {
  id: 'SEC-22',
  rule: 'generic-api-key',
  path: '.github/workflows/release-candidate.yml',
};
if (
  gitleaksSuppressions.length !== 1 ||
  Object.entries(expectedGitleaksSuppression).some(
    ([field, value]) => gitleaksSuppressions[0]?.[field] !== value,
  )
)
  fail('Gitleaks suppression differs from the reviewed policy');

const gitleaksConfig = await readFile(join(root, '.gitleaks.toml'), 'utf8');
const expectedGitleaksConfig = `title = "NexaChat Gitleaks policy"

[extend]
useDefault = true

[[allowlists]]
description = "SEC-22 public release-evidence service versions"
targetRules = ["generic-api-key"]
condition = "AND"
regexTarget = "line"
paths = ['''(^|.*/)\\.github/workflows/release-candidate\\.yml$''']
regexes = ['''^\\s*services:\\s*\\{\\s*postgres:\\s*"17\\.10-alpine3\\.23",\\s*valkey:\\s*"8\\.1\\.9-alpine3\\.24"\\s*\\},\\s*$''']
`;
if (gitleaksConfig !== expectedGitleaksConfig)
  fail('Gitleaks allowlist is broader than the reviewed policy');

const lock = JSON.parse(
  await readFile(join(root, 'package-lock.json'), 'utf8'),
);
const allowedLicenses = new Set(policy.allowedLicenses ?? []);
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path || entry.link) continue;
  if (!isApprovedLicenseExpression(entry.license, allowedLicenses))
    fail(`${path}: unreviewed or missing license ${String(entry.license)}`);
  if (path.startsWith('node_modules/')) {
    if (!/^sha512-[A-Za-z0-9+/=]+$/u.test(entry.integrity ?? ''))
      fail(`${path}: lockfile integrity is missing or invalid`);
    if (!/^https:\/\/registry\.npmjs\.org\//u.test(entry.resolved ?? ''))
      fail(`${path}: dependency source is not the reviewed npm registry`);
  }
}

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (path !== '' && !/^(apps|packages)\/[^/]+$/u.test(path)) continue;
  if (entry.license !== 'GPL-3.0-only')
    fail(`${path || 'root'}: workspace license must be GPL-3.0-only`);
  for (const [name, version] of Object.entries({
    ...(entry.dependencies ?? {}),
    ...(entry.devDependencies ?? {}),
    ...(entry.optionalDependencies ?? {}),
  })) {
    if (
      !name.startsWith('@nexa/') &&
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
    )
      fail(`${path || 'root'}: dependency ${name} is not exactly pinned`);
  }
}

const workflowDirectory = join(root, '.github', 'workflows');
const permissionExceptions = policy.workflowPermissionExceptions ?? {};
const observedPermissionExceptions = new Set();
const validWorkflowPermissions = new Set([
  'actions',
  'attestations',
  'checks',
  'contents',
  'deployments',
  'discussions',
  'id-token',
  'issues',
  'packages',
  'pages',
  'pull-requests',
  'security-events',
  'statuses',
]);
for (const [file, exception] of Object.entries(permissionExceptions)) {
  if (!/^[a-zA-Z0-9_.-]+\.ya?ml$/u.test(file))
    fail(`invalid workflow permission exception name ${file}`);
  if (!exception || typeof exception !== 'object' || Array.isArray(exception)) {
    fail(`${file}: workflow permission exception is invalid`);
    continue;
  }
  if (!exception.owner?.startsWith('@') || !exception.rationale)
    fail(`${file}: workflow permission exception lacks an owner or rationale`);
  if (!Number.isFinite(Date.parse(exception.reviewAfter)))
    fail(`${file}: workflow permission exception lacks a review date`);
  if (Date.now() > Date.parse(exception.reviewAfter))
    fail(`${file}: workflow permission exception is overdue for review`);
  const permissions = exception.permissions ?? {};
  if (
    !permissions ||
    typeof permissions !== 'object' ||
    Array.isArray(permissions)
  ) {
    fail(`${file}: workflow permission exception map is invalid`);
    continue;
  }
  if (!Object.keys(permissions).length)
    fail(`${file}: workflow permission exception is empty`);
  for (const [permission, access] of Object.entries(permissions)) {
    if (!validWorkflowPermissions.has(permission))
      fail(`${file}: workflow permission ${permission} is invalid`);
    if (!['read', 'write', 'none'].includes(access))
      fail(`${file}: workflow permission ${permission} has invalid access`);
  }
}

for (const file of await readdir(workflowDirectory)) {
  if (!/\.ya?ml$/u.test(file)) continue;
  const text = await readFile(join(workflowDirectory, file), 'utf8');
  if (/^\s*(pull_request_target|workflow_run|issue_comment):/mu.test(text))
    fail(`${file}: privileged event can process untrusted pull-request input`);
  if (/\$\{\{\s*(github\.event|inputs\.)/u.test(extractRunBlocks(text)))
    fail(`${file}: untrusted expression is interpolated into a shell block`);
  if (text.includes('pull_request:')) {
    if (!/concurrency:[\s\S]*?cancel-in-progress:\s*true/u.test(text))
      fail(`${file}: pull-request concurrency cancellation is missing`);
    if (/secrets\./u.test(text))
      fail(`${file}: pull-request workflow references repository secrets`);
    if (
      /\b(?:contents|id-token|packages|security-events):\s*write\b/u.test(text)
    )
      fail(
        `${file}: pull-request workflow grants a privileged token permission`,
      );
  }
  const permissionException = permissionExceptions[file];
  const expectedPermissions = permissionException?.permissions ?? {
    contents: 'read',
  };
  const workflowPermissions = extractWorkflowPermissions(text);
  if (!samePermissions(workflowPermissions, expectedPermissions))
    fail(`${file}: workflow default permissions differ from reviewed policy`);
  if (permissionException) observedPermissionExceptions.add(file);

  const uses = [
    ...text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?/gmu),
  ];
  if (
    uses.some(([, reference]) =>
      reference.startsWith('actions/dependency-review-action@'),
    )
  ) {
    const configuredLicenses = /^\s*allow-licenses:\s*(.+)$/mu.exec(text)?.[1];
    const workflowLicenses = configuredLicenses
      ?.split(',')
      .map((license) => license.trim());
    if (!sameStringSet(workflowLicenses, policy.allowedLicenses))
      fail(`${file}: dependency-review licenses differ from reviewed policy`);
  }
  for (const [, reference, comment] of uses) {
    if (reference.startsWith('./')) continue;
    const match = /^([^@]+)@([0-9a-f]{40})$/u.exec(reference);
    if (!match) {
      fail(`${file}: action ${reference} is not pinned to a full commit`);
      continue;
    }
    const [, action, revision] = match;
    if (policy.actions?.[action] !== revision)
      fail(`${file}: action ${action} is not the reviewed revision`);
    if (!/^v\d/u.test(comment ?? ''))
      fail(`${file}: action ${action} lacks a human-readable version comment`);
  }

  const jobsText = text.split(/^jobs:\s*$/mu)[1] ?? '';
  const jobHeaders = [
    ...jobsText.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9_-]*):\n/gmu),
  ];
  if (!jobHeaders.length) fail(`${file}: workflow has no jobs`);
  for (const [index, header] of jobHeaders.entries()) {
    const job = header[1];
    const start = header.index + header[0].length;
    const body = jobsText.slice(start, jobHeaders[index + 1]?.index);
    if (!/^ {4}timeout-minutes:\s*\d+$/mu.test(body))
      fail(`${file}: job ${job} has no timeout`);
  }
}

for (const file of Object.keys(permissionExceptions)) {
  if (!observedPermissionExceptions.has(file))
    fail(`${file}: workflow permission exception does not match a workflow`);
}

for (const [action, revision] of Object.entries(policy.actions ?? {})) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(action))
    fail(`invalid action name ${action}`);
  if (!/^[0-9a-f]{40}$/u.test(revision))
    fail(`action ${action} does not use a full revision`);
}
for (const [scanner, image] of Object.entries(policy.scannerImages ?? {})) {
  if (!/^[^\s]+:[^\s@]+@sha256:[0-9a-f]{64}$/u.test(image))
    fail(`scanner ${scanner} is not immutable`);
}

const pinnedImageSources = [
  ['Dockerfile', /^FROM\s+(?:--platform=[^\s]+\s+)?([^\s]+).*$/gmu],
  ['docker-compose.yml', /^\s*image:\s*([^\s]+).*$/gmu],
  ['compose.production.yml', /^\s*image:\s*([^\s]+).*$/gmu],
];
for (const [file, expression] of pinnedImageSources) {
  const text = await readFile(join(root, file), 'utf8');
  for (const [, image] of text.matchAll(expression)) {
    if (
      image.includes('${') ||
      image.startsWith('nexa-chat-') ||
      (!image.includes('/') && !image.includes(':'))
    )
      continue;
    if (!/@sha256:[0-9a-f]{64}$/u.test(image))
      fail(`${file}: external image ${image} is not digest-pinned`);
  }
}
const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
if (!/^# syntax=[^\s]+@sha256:[0-9a-f]{64}$/mu.test(dockerfile))
  fail('Dockerfile frontend is not digest-pinned');
const developmentCompose = await readFile(
  join(root, 'docker-compose.yml'),
  'utf8',
);
const loopbackBindings = [
  ...developmentCompose.matchAll(
    /^\s*host_ip:\s*'\$\{NEXA_DEVELOPMENT_BIND_ADDRESS:-127\.0\.0\.1\}'$/gmu,
  ),
];
if (loopbackBindings.length !== 3)
  fail('development provider ports must default to loopback');

const objectStorageBuild = policy.sourceBuilds?.objectStorage;
if (!objectStorageBuild) {
  fail('object-storage source-build policy is missing');
} else {
  const {
    archiveSha256,
    builderImage,
    dependencyOverrides,
    repository,
    revision,
    runtimeImage,
  } = objectStorageBuild;
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(
      repository,
    )
  )
    fail('object-storage source repository is invalid');
  if (!/^[0-9a-f]{40}$/u.test(revision))
    fail('object-storage source revision is not immutable');
  if (!/^[0-9a-f]{64}$/u.test(archiveSha256))
    fail('object-storage source checksum is invalid');
  if (!/@sha256:[0-9a-f]{64}$/u.test(builderImage))
    fail('object-storage builder image is not immutable');
  if (!/@sha256:[0-9a-f]{64}$/u.test(runtimeImage))
    fail('object-storage runtime image is not immutable');

  const [owner, repositoryName] = repository.split('/').slice(-2);
  const archiveUrl = `https://codeload.github.com/${owner}/${repositoryName}/tar.gz/${revision}`;
  if (
    !dockerfile.includes(
      `FROM --platform=$BUILDPLATFORM ${builderImage} AS object-storage-build`,
    ) ||
    !dockerfile.includes(`ADD --checksum=sha256:${archiveSha256}`) ||
    !dockerfile.includes(archiveUrl) ||
    !dockerfile.includes(`FROM ${runtimeImage} AS object-storage-runtime`)
  )
    fail('object-storage source-build inputs differ from reviewed policy');

  for (const [dependency, override] of Object.entries(
    dependencyOverrides ?? {},
  )) {
    const { goModSum, sum, version } = override ?? {};
    if (
      !/^[A-Za-z0-9_.~/-]+$/u.test(dependency) ||
      !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ||
      !/^h1:[A-Za-z0-9+/]{43}=$/u.test(sum) ||
      !/^h1:[A-Za-z0-9+/]{43}=$/u.test(goModSum)
    )
      fail(`object-storage dependency override ${dependency} is invalid`);
    if (!dockerfile.includes(`go mod edit -require=${dependency}@${version}`))
      fail(`object-storage dependency override ${dependency} is not enforced`);
    if (!dockerfile.includes(`"Sum": "${sum}"`))
      fail(
        `object-storage dependency override ${dependency} sum is not pinned`,
      );
    if (!dockerfile.includes(`"GoModSum": "${goModSum}"`))
      fail(
        `object-storage dependency override ${dependency} go.mod sum is not pinned`,
      );
  }
}

const scannerSources = [
  ['scripts/run-secret-scan.sh', policy.scannerImages.gitleaks],
  ['scripts/run-static-analysis.sh', policy.scannerImages.semgrep],
  ['scripts/scan-production-images.sh', policy.scannerImages.trivy],
];
for (const [file, image] of scannerSources) {
  const text = await readFile(join(root, file), 'utf8');
  if (!text.includes(image)) fail(`${file}: scanner pin differs from policy`);
}

const migrations = (await readdir(join(root, 'apps', 'server', 'migrations')))
  .filter((file) => file.endsWith('.sql'))
  .sort();
for (const [index, file] of migrations.entries()) {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/u.exec(file);
  if (!match || Number(match[1]) !== index + 1)
    fail(`migration ordering is invalid at ${file}`);
  const sql = await readFile(
    join(root, 'apps', 'server', 'migrations', file),
    'utf8',
  );
  if (!hasCompleteSqlStatement(sql))
    fail(`${file}: migration is not complete SQL`);
}

const semgrep = await readFile(join(root, '.semgrep.yml'), 'utf8');
for (const rule of [
  'nexa-javascript-eval',
  'nexa-disabled-tls-verification',
  'nexa-dangerous-html-injection',
  'nexa-shell-command-execution',
]) {
  if (!semgrep.includes(`id: ${rule}`)) fail(`missing static rule ${rule}`);
}

if (failures.length) {
  for (const failure of failures)
    console.error(`security_policy_error: ${failure}`);
  process.exit(1);
}
console.log(
  `Security policy verified: ${Object.keys(lock.packages).length} lock entries, ${migrations.length} ordered migrations, immutable workflows and scanners.`,
);

function extractRunBlocks(text) {
  const blocks = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/u.exec(lines[index]);
    if (!match) continue;
    const indentation = match[1].length;
    const body = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() && line.search(/\S/u) <= indentation) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks.join('\n');
}

function extractWorkflowPermissions(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^permissions:\s*$/u.test(line));
  if (start < 0) return null;
  const permissions = {};
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (!/^\s/u.test(line)) break;
    const match = /^ {2}([a-z][a-z-]*):\s*(read|write|none)\s*$/u.exec(line);
    if (!match || Object.hasOwn(permissions, match[1])) return null;
    permissions[match[1]] = match[2];
  }
  return permissions;
}

function samePermissions(actual, expected) {
  if (!actual) return false;
  const actualEntries = Object.entries(actual).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

function sameStringSet(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  const sortedActual = [...new Set(actual)].sort();
  const sortedExpected = [...new Set(expected)].sort();
  if (
    sortedActual.length !== actual.length ||
    sortedExpected.length !== expected.length
  )
    return false;
  return JSON.stringify(sortedActual) === JSON.stringify(sortedExpected);
}
