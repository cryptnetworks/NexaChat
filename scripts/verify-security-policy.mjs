import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (!suppression.owner || !suppression.rationale)
    fail(`suppression ${index} lacks an owner or rationale`);
  if (!Number.isFinite(Date.parse(suppression.reviewAfter)))
    fail(`suppression ${index} lacks a review date`);
  if (Date.now() > Date.parse(suppression.reviewAfter))
    fail(`suppression ${index} is overdue for review`);
}

const lock = JSON.parse(
  await readFile(join(root, 'package-lock.json'), 'utf8'),
);
const allowedLicenses = new Set(policy.allowedLicenses ?? []);
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path || entry.link) continue;
  if (!entry.license || !allowedLicenses.has(entry.license))
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
  if (!/^permissions:\n {2}contents: read$/mu.test(text))
    fail(`${file}: workflow default permissions are not contents: read`);

  const uses = [
    ...text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?/gmu),
  ];
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
  ['Dockerfile', /^FROM\s+([^\s]+).*$/gmu],
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
  if (!sql.trim().endsWith(';')) fail(`${file}: migration is not complete SQL`);
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
