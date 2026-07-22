import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const FRAGMENT_NAME_PATTERN = /^(\d+)-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;
const RELEASE_MARKER = '<!-- release-notes -->';
const MAX_FRAGMENT_BYTES = 4096;
const MAX_SUMMARY_LENGTH = 240;
const MAX_MIGRATION_LENGTH = 1000;
const CATEGORY_ORDER = [
  'security',
  'added',
  'changed',
  'fixed',
  'deprecated',
  'removed',
] as const;
const AUDIENCES = ['users', 'operators', 'developers', 'internal'] as const;
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

type Category = (typeof CATEGORY_ORDER)[number];
type Audience = (typeof AUDIENCES)[number];
type JsonObject = Record<string, unknown>;

export interface ReleaseFragment {
  schemaVersion: 1;
  issue: number;
  category: Category;
  summary: string;
  audience: Audience;
  packages: string[];
  breaking: boolean;
  migration: string | null;
  file: string;
}

export interface ReleaseCheck {
  version: string;
  manifests: string[];
  fragments: ReleaseFragment[];
}

export interface ReleasePlan {
  currentVersion: string;
  targetVersion: string;
  date: string;
  writes: Map<string, string>;
  deletes: string[];
}

export class ReleaseValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReleaseValidationError';
  }
}

function fail(message: string): never {
  throw new ReleaseValidationError(message);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readUtf8(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function readJson(path: string): Promise<JsonObject> {
  let value: unknown;
  try {
    value = JSON.parse(await readUtf8(path));
  } catch {
    return fail(`invalid JSON: ${path}`);
  }
  if (!isObject(value)) fail(`expected a JSON object: ${path}`);
  return value;
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseSemanticVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
} {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) fail(`invalid semantic version: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareSemanticVersions(left: string, right: string): number {
  const a = parseSemanticVersion(left);
  const b = parseSemanticVersion(right);
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function expectString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  let hasControlCharacter = false;
  if (typeof value === 'string') {
    for (const character of value) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint <= 31 || codePoint === 127) {
        hasControlCharacter = true;
        break;
      }
    }
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    hasControlCharacter ||
    value.trim() !== value
  ) {
    fail(`invalid ${field}`);
  }
  return value;
}

async function discoverManifestPaths(root: string): Promise<string[]> {
  const paths = ['package.json'];
  for (const directory of ['apps', 'packages']) {
    const entries = await readdir(resolve(root, directory), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const manifest = resolve(root, directory, entry.name, 'package.json');
      try {
        if ((await stat(manifest)).isFile())
          paths.push(relative(root, manifest));
      } catch {
        // A workspace directory without a package manifest is not publishable.
      }
    }
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

function packageName(manifest: JsonObject, path: string): string {
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    fail(`missing package name: ${path}`);
  }
  return manifest.name;
}

function packageVersion(manifest: JsonObject, path: string): string {
  if (typeof manifest.version !== 'string')
    fail(`missing package version: ${path}`);
  parseSemanticVersion(manifest.version);
  return manifest.version;
}

function workspaceLockKey(manifestPath: string): string {
  return manifestPath === 'package.json'
    ? ''
    : manifestPath.replace(/\/package\.json$/, '');
}

function checkInternalPins(
  manifest: JsonObject,
  path: string,
  internalNames: Set<string>,
  version: string,
): void {
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!isObject(dependencies)) fail(`invalid ${field}: ${path}`);
    for (const [name, pin] of Object.entries(dependencies)) {
      if (internalNames.has(name) && pin !== version) {
        fail(
          `internal dependency ${name} in ${path} must be pinned to ${version}`,
        );
      }
    }
  }
}

function parseFragment(
  value: JsonObject,
  file: string,
  availablePackages: Set<string>,
): ReleaseFragment {
  const allowed = new Set([
    'schemaVersion',
    'issue',
    'category',
    'summary',
    'audience',
    'packages',
    'breaking',
    'migration',
  ]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) fail(`unexpected fragment fields in ${file}`);
  if (value.schemaVersion !== 1) fail(`unsupported fragment schema in ${file}`);
  if (!Number.isSafeInteger(value.issue) || Number(value.issue) <= 0) {
    fail(`invalid issue in ${file}`);
  }
  const filenameMatch = FRAGMENT_NAME_PATTERN.exec(file);
  if (!filenameMatch || Number(filenameMatch[1]) !== value.issue) {
    fail(`fragment filename does not match issue in ${file}`);
  }
  if (!CATEGORY_ORDER.includes(value.category as Category))
    fail(`invalid category in ${file}`);
  if (!AUDIENCES.includes(value.audience as Audience))
    fail(`invalid audience in ${file}`);
  const summary = expectString(
    value.summary,
    `summary in ${file}`,
    MAX_SUMMARY_LENGTH,
  );
  if (
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    value.packages.length > 32
  ) {
    fail(`invalid packages in ${file}`);
  }
  const packages = value.packages.map((name) => {
    if (typeof name !== 'string' || !availablePackages.has(name)) {
      return fail(`unknown package in ${file}`);
    }
    return name;
  });
  if (new Set(packages).size !== packages.length)
    fail(`duplicate package in ${file}`);
  if (JSON.stringify(packages) !== JSON.stringify([...packages].sort())) {
    fail(`packages must be sorted in ${file}`);
  }
  if (typeof value.breaking !== 'boolean')
    fail(`invalid breaking flag in ${file}`);
  const migration =
    value.migration === null
      ? null
      : expectString(
          value.migration,
          `migration in ${file}`,
          MAX_MIGRATION_LENGTH,
        );
  if (value.breaking && migration === null)
    fail(`breaking fragment needs migration in ${file}`);
  if (!value.breaking && migration !== null)
    fail(`non-breaking fragment cannot have migration in ${file}`);
  return {
    schemaVersion: 1,
    issue: value.issue,
    category: value.category as Category,
    summary,
    audience: value.audience as Audience,
    packages,
    breaking: value.breaking,
    migration,
    file,
  };
}

async function readFragments(
  root: string,
  packageNames: Set<string>,
): Promise<ReleaseFragment[]> {
  const directory = resolve(root, '.changes');
  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));
  const fragments: ReleaseFragment[] = [];
  const issues = new Set<number>();
  for (const file of files) {
    const path = resolve(directory, file);
    const details = await stat(path);
    if (!details.isFile() || details.size > MAX_FRAGMENT_BYTES) {
      fail(`fragment exceeds ${String(MAX_FRAGMENT_BYTES)} bytes: ${file}`);
    }
    const fragment = parseFragment(await readJson(path), file, packageNames);
    if (issues.has(fragment.issue))
      fail(`duplicate issue fragment: ${String(fragment.issue)}`);
    issues.add(fragment.issue);
    fragments.push(fragment);
  }
  return fragments;
}

function cargoPackageVersion(contents: string): string {
  const match = /^\[package\]\n[\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(
    contents,
  );
  if (!match?.[1]) fail('missing desktop Cargo package version');
  return match[1];
}

function cargoLockPackageVersion(contents: string): string {
  const match =
    /\[\[package\]\]\nname = "nexa-desktop"\nversion = "([^"]+)"/.exec(
      contents,
    );
  if (!match?.[1]) fail('missing desktop Cargo.lock package version');
  return match[1];
}

function assertVersion(
  actual: unknown,
  expected: string,
  location: string,
): void {
  if (actual !== expected)
    fail(`version mismatch in ${location}: expected ${expected}`);
}

export async function checkReleaseState(
  root = REPOSITORY_ROOT,
): Promise<ReleaseCheck> {
  const manifestPaths = await discoverManifestPaths(root);
  const manifests = new Map<string, JsonObject>();
  for (const path of manifestPaths)
    manifests.set(path, await readJson(resolve(root, path)));
  const rootManifest = manifests.get('package.json');
  if (!rootManifest) fail('missing root package manifest');
  const version = packageVersion(rootManifest, 'package.json');
  const packageNames = new Set<string>();
  for (const [path, manifest] of manifests) {
    const name = packageName(manifest, path);
    if (packageNames.has(name)) fail(`duplicate package name: ${name}`);
    packageNames.add(name);
    assertVersion(packageVersion(manifest, path), version, path);
  }
  for (const [path, manifest] of manifests) {
    checkInternalPins(manifest, path, packageNames, version);
  }

  const lock = await readJson(resolve(root, 'package-lock.json'));
  assertVersion(lock.version, version, 'package-lock.json');
  if (!isObject(lock.packages)) fail('invalid package-lock packages');
  for (const path of manifestPaths) {
    const lockEntry = lock.packages[workspaceLockKey(path)];
    if (!isObject(lockEntry)) fail(`missing package-lock workspace: ${path}`);
    assertVersion(lockEntry.version, version, `package-lock.json:${path}`);
    checkInternalPins(
      lockEntry,
      `package-lock.json:${path}`,
      packageNames,
      version,
    );
  }

  const cargoToml = await readUtf8(
    resolve(root, 'apps/desktop/src-tauri/Cargo.toml'),
  );
  assertVersion(
    cargoPackageVersion(cargoToml),
    version,
    'apps/desktop/src-tauri/Cargo.toml',
  );
  const cargoLock = await readUtf8(
    resolve(root, 'apps/desktop/src-tauri/Cargo.lock'),
  );
  assertVersion(
    cargoLockPackageVersion(cargoLock),
    version,
    'apps/desktop/src-tauri/Cargo.lock',
  );
  const tauri = await readJson(
    resolve(root, 'apps/desktop/src-tauri/tauri.conf.json'),
  );
  assertVersion(
    tauri.version,
    version,
    'apps/desktop/src-tauri/tauri.conf.json',
  );

  const changelog = await readUtf8(resolve(root, 'CHANGELOG.md'));
  if ((changelog.match(new RegExp(RELEASE_MARKER, 'g')) ?? []).length !== 1) {
    fail('CHANGELOG.md must contain exactly one release marker');
  }
  const fragments = await readFragments(root, packageNames);
  return { version, manifests: manifestPaths, fragments };
}

function replaceCargoVersion(contents: string, version: string): string {
  const pattern = /(^\[package\]\n[\s\S]*?^version\s*=\s*")([^"]+)(")/m;
  if (!pattern.test(contents)) fail('missing desktop Cargo package version');
  return contents.replace(pattern, `$1${version}$3`);
}

function replaceCargoLockVersion(contents: string, version: string): string {
  const pattern =
    /(\[\[package\]\]\nname = "nexa-desktop"\nversion = ")([^"]+)(")/;
  if (!pattern.test(contents))
    fail('missing desktop Cargo.lock package version');
  return contents.replace(pattern, `$1${version}$3`);
}

function updateManifest(
  manifest: JsonObject,
  version: string,
  internalNames: Set<string>,
): JsonObject {
  const updated = structuredClone(manifest);
  updated.version = version;
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = updated[field];
    if (!isObject(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      if (internalNames.has(name)) dependencies[name] = version;
    }
  }
  return updated;
}

function markdown(value: string): string {
  const escapedCharacters = new Set('\\`*_{}[]<>()#+.!|');
  let escaped = '';
  for (const character of value) {
    escaped += escapedCharacters.has(character) ? `\\${character}` : character;
  }
  return escaped;
}

function renderReleaseNotes(
  version: string,
  date: string,
  fragments: ReleaseFragment[],
): string {
  const headings: Record<Category, string> = {
    security: 'Security',
    added: 'Added',
    changed: 'Changed',
    fixed: 'Fixed',
    deprecated: 'Deprecated',
    removed: 'Removed',
  };
  const lines = [`## [${version}] - ${date}`];
  for (const category of CATEGORY_ORDER) {
    const selected = fragments.filter(
      (fragment) => fragment.category === category,
    );
    if (selected.length === 0) continue;
    lines.push('', `### ${headings[category]}`, '');
    for (const fragment of selected) {
      const scopes = fragment.packages.map(markdown).join(', ');
      lines.push(
        `- ${markdown(fragment.summary)} (#${String(fragment.issue)}; ${scopes})`,
      );
    }
  }
  const breaking = fragments.filter((fragment) => fragment.breaking);
  if (breaking.length > 0) {
    lines.push('', '### Migration', '');
    for (const fragment of breaking) {
      lines.push(
        `- ${markdown(fragment.migration ?? '')} (#${String(fragment.issue)})`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`invalid release date: ${date}`);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    fail(`invalid release date: ${date}`);
  }
}

export async function prepareRelease(
  root: string,
  targetVersion: string,
  date: string,
): Promise<ReleasePlan> {
  parseSemanticVersion(targetVersion);
  validateDate(date);
  const check = await checkReleaseState(root);
  if (compareSemanticVersions(targetVersion, check.version) <= 0) {
    fail(`target version must be newer than ${check.version}`);
  }
  if (check.fragments.length === 0)
    fail('release preparation requires at least one fragment');

  const manifests = new Map<string, JsonObject>();
  const packageNames = new Set<string>();
  for (const path of check.manifests) {
    const manifest = await readJson(resolve(root, path));
    manifests.set(path, manifest);
    packageNames.add(packageName(manifest, path));
  }
  const writes = new Map<string, string>();
  for (const [path, manifest] of manifests) {
    writes.set(
      path,
      stringifyJson(updateManifest(manifest, targetVersion, packageNames)),
    );
  }

  const lock = await readJson(resolve(root, 'package-lock.json'));
  lock.version = targetVersion;
  if (!isObject(lock.packages)) fail('invalid package-lock packages');
  for (const path of check.manifests) {
    const lockKey = workspaceLockKey(path);
    const entry = lock.packages[lockKey];
    if (!isObject(entry)) fail(`missing package-lock workspace: ${path}`);
    const updated = updateManifest(entry, targetVersion, packageNames);
    lock.packages[lockKey] = updated;
  }
  writes.set('package-lock.json', stringifyJson(lock));

  const cargoPath = 'apps/desktop/src-tauri/Cargo.toml';
  writes.set(
    cargoPath,
    replaceCargoVersion(
      await readUtf8(resolve(root, cargoPath)),
      targetVersion,
    ),
  );
  const cargoLockPath = 'apps/desktop/src-tauri/Cargo.lock';
  writes.set(
    cargoLockPath,
    replaceCargoLockVersion(
      await readUtf8(resolve(root, cargoLockPath)),
      targetVersion,
    ),
  );
  const tauriPath = 'apps/desktop/src-tauri/tauri.conf.json';
  const tauri = await readJson(resolve(root, tauriPath));
  tauri.version = targetVersion;
  writes.set(tauriPath, stringifyJson(tauri));

  const changelog = await readUtf8(resolve(root, 'CHANGELOG.md'));
  if (changelog.includes(`## [${targetVersion}]`))
    fail('target version already exists in changelog');
  const notes = renderReleaseNotes(targetVersion, date, check.fragments);
  writes.set(
    'CHANGELOG.md',
    changelog.replace(RELEASE_MARKER, `${RELEASE_MARKER}\n\n${notes}`),
  );

  return {
    currentVersion: check.version,
    targetVersion,
    date,
    writes,
    deletes: check.fragments.map((fragment) => `.changes/${fragment.file}`),
  };
}

export function summarizePlan(plan: ReleasePlan): JsonObject {
  const files = [...plan.writes]
    .map(([path, contents]) => ({
      path,
      sha256: createHash('sha256').update(contents).digest('hex'),
      bytes: Buffer.byteLength(contents),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: 1,
    currentVersion: plan.currentVersion,
    targetVersion: plan.targetVersion,
    date: plan.date,
    writes: files,
    deletes: [...plan.deletes].sort(),
  };
}

export async function applyReleasePlan(
  root: string,
  plan: ReleasePlan,
): Promise<void> {
  const temporaryFiles: string[] = [];
  try {
    for (const [path, contents] of plan.writes) {
      const destination = resolve(root, path);
      const temporary = `${destination}.release-${String(process.pid)}.tmp`;
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
      temporaryFiles.push(temporary);
    }
    for (const [path] of plan.writes) {
      const destination = resolve(root, path);
      const temporary = `${destination}.release-${String(process.pid)}.tmp`;
      await rename(temporary, destination);
      temporaryFiles.splice(temporaryFiles.indexOf(temporary), 1);
    }
    for (const path of plan.deletes) await rm(resolve(root, path));
  } finally {
    await Promise.all(
      temporaryFiles.map(async (path) => rm(path, { force: true })),
    );
  }
}

function argumentValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  return args
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

async function main(args: string[]): Promise<void> {
  const [command, ...options] = args;
  if (command === 'check' && options.length === 0) {
    const result = await checkReleaseState();
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, status: 'ok', version: result.version, manifests: result.manifests.length, fragments: result.fragments.length })}\n`,
    );
    return;
  }
  if (command === 'prepare') {
    const allowed = options.every(
      (option) =>
        option === '--write' ||
        option.startsWith('--version=') ||
        option.startsWith('--date='),
    );
    const version = argumentValue(options, '--version');
    const date = argumentValue(options, '--date');
    if (
      !allowed ||
      !version ||
      !date ||
      options.filter((option) => option === '--write').length > 1
    ) {
      fail('usage: prepare --version=X.Y.Z --date=YYYY-MM-DD [--write]');
    }
    const plan = await prepareRelease(REPOSITORY_ROOT, version, date);
    const shouldWrite = options.includes('--write');
    if (shouldWrite) await applyReleasePlan(REPOSITORY_ROOT, plan);
    process.stdout.write(
      `${JSON.stringify({ ...summarizePlan(plan), mode: shouldWrite ? 'write' : 'dry-run' }, null, 2)}\n`,
    );
    return;
  }
  fail(
    'usage: versioning.ts check | prepare --version=X.Y.Z --date=YYYY-MM-DD [--write]',
  );
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof ReleaseValidationError
        ? error.message
        : 'unexpected failure';
    process.stderr.write(`release_validation_failed: ${message}\n`);
    process.exitCode = 1;
  });
}
