import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './artifact-bundle.js';
import { parseSemanticVersion } from './versioning.js';

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MIN_SOURCE_EPOCH = 946_684_800;
const MAX_SOURCE_EPOCH = 4_102_444_800;

type JsonObject = Record<string, unknown>;

interface CargoPackage {
  name: string;
  version: string;
  source?: string;
  checksum?: string;
}

export interface SbomSummary {
  version: string;
  npmComponents: number;
  cargoComponents: number;
  files: string[];
}

export class SbomValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SbomValidationError';
  }
}

function fail(message: string): never {
  throw new SbomValidationError(message);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function deterministicUuid(digest: string): string {
  const characters = digest.slice(0, 32).split('');
  characters[12] = '5';
  const variant = Number.parseInt(characters[16] ?? '0', 16);
  characters[16] = ((variant & 0x3) | 0x8).toString(16);
  const hex = characters.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

async function boundedText(path: string): Promise<string> {
  const details = await lstat(path);
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size <= 0 ||
    details.size > MAX_INPUT_BYTES
  ) {
    fail('SBOM input must be a bounded regular file');
  }
  return readFile(path, 'utf8');
}

function parseObject(contents: string, context: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return fail(`${context} is not valid JSON`);
  }
  if (!isObject(value)) fail(`${context} must be a JSON object`);
  return value;
}

function componentSortValue(value: unknown): string {
  if (!isObject(value)) return '';
  if (typeof value['bom-ref'] === 'string') return value['bom-ref'];
  if (typeof value.ref === 'string') return value.ref;
  if (typeof value.purl === 'string') return value.purl;
  const name = typeof value.name === 'string' ? value.name : '';
  const version = typeof value.version === 'string' ? value.version : '';
  return `${name}@${version}`;
}

function normalizeArray(value: unknown, childKey?: string): void {
  if (!Array.isArray(value)) return;
  if (childKey) {
    for (const item of value) {
      if (isObject(item) && Array.isArray(item[childKey])) {
        (item[childKey] as unknown[]).sort((left, right) =>
          String(left).localeCompare(String(right)),
        );
      }
    }
  }
  value.sort((left, right) =>
    componentSortValue(left).localeCompare(componentSortValue(right)),
  );
}

export function normalizeNpmSbom(
  raw: JsonObject,
  lockDigest: string,
  timestamp: string,
  repositoryRoot: string,
): JsonObject {
  if (
    raw.bomFormat !== 'CycloneDX' ||
    !['1.5', '1.6'].includes(String(raw.specVersion)) ||
    raw.version !== 1 ||
    !isObject(raw.metadata) ||
    !Array.isArray(raw.components)
  ) {
    fail('npm returned an invalid CycloneDX document');
  }
  const normalized = structuredClone(raw);
  normalized.serialNumber = `urn:uuid:${deterministicUuid(lockDigest)}`;
  if (!isObject(normalized.metadata)) fail('npm SBOM metadata is invalid');
  normalized.metadata.timestamp = timestamp;
  normalizeArray(normalized.components);
  normalizeArray(normalized.dependencies, 'dependsOn');
  const serialized = canonicalJson(normalized);
  if (serialized.includes(repositoryRoot))
    fail('npm SBOM contains an absolute repository path');
  return normalized;
}

export function parseCargoLock(contents: string): CargoPackage[] {
  const packages: CargoPackage[] = [];
  const blocks = contents.split(/^\[\[package\]\]\s*$/mu).slice(1);
  for (const block of blocks) {
    const name = /^name = "([^"]+)"$/mu.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/mu.exec(block)?.[1];
    const source = /^source = "([^"]+)"$/mu.exec(block)?.[1];
    const checksum = /^checksum = "([0-9a-f]{64})"$/mu.exec(block)?.[1];
    if (!name || !version) fail('Cargo.lock contains an invalid package block');
    packages.push({
      name,
      version,
      ...(source ? { source } : {}),
      ...(checksum ? { checksum } : {}),
    });
  }
  if (packages.length === 0) fail('Cargo.lock contains no packages');
  return packages.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(
      `${right.name}@${right.version}`,
    ),
  );
}

function cargoPurl(pkg: CargoPackage): string {
  return `pkg:cargo/${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}`;
}

function cargoBomReference(pkg: CargoPackage): string {
  return `${cargoPurl(pkg)}#source-${sha256(pkg.source ?? 'workspace').slice(0, 12)}`;
}

export function cargoSbom(
  packages: CargoPackage[],
  version: string,
  lockDigest: string,
  timestamp: string,
): JsonObject {
  const rootReference = `pkg:cargo/nexa-desktop@${encodeURIComponent(version)}`;
  const components = packages
    .filter((pkg) => !(pkg.name === 'nexa-desktop' && pkg.version === version))
    .map((pkg) => ({
      type: 'library',
      'bom-ref': cargoBomReference(pkg),
      name: pkg.name,
      version: pkg.version,
      purl: cargoPurl(pkg),
      ...(pkg.checksum
        ? { hashes: [{ alg: 'SHA-256', content: pkg.checksum }] }
        : {}),
      ...(pkg.source
        ? { properties: [{ name: 'nexa:cargo:source', value: pkg.source }] }
        : {}),
    }));
  return {
    $schema: 'https://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${deterministicUuid(lockDigest)}`,
    version: 1,
    metadata: {
      timestamp,
      tools: {
        components: [
          {
            type: 'application',
            name: 'nexa-release-sbom',
            version: '1',
          },
        ],
      },
      component: {
        type: 'application',
        'bom-ref': rootReference,
        name: 'nexa-desktop',
        version,
        purl: rootReference,
      },
      properties: [{ name: 'nexa:cargo-lock:sha256', value: lockDigest }],
    },
    components,
    dependencies: [
      {
        ref: rootReference,
        dependsOn: components.map((component) => component['bom-ref']).sort(),
      },
    ],
  };
}

async function writeNewOrIdentical(
  path: string,
  contents: string,
): Promise<void> {
  try {
    const current = await readFile(path, 'utf8');
    if (current !== contents) fail('refusing to replace a different SBOM');
  } catch (error) {
    if (error instanceof SbomValidationError) throw error;
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

export async function generateSboms(
  repositoryRootInput: string,
  outputDirectoryInput: string,
  sourceDateEpoch: number,
): Promise<SbomSummary> {
  const repositoryRoot = resolve(repositoryRootInput);
  const outputDirectory = resolve(outputDirectoryInput);
  if (!(await lstat(outputDirectory)).isDirectory())
    fail('SBOM output is not a directory');
  const rootManifest = parseObject(
    await boundedText(resolve(repositoryRoot, 'package.json')),
    'root manifest',
  );
  if (typeof rootManifest.version !== 'string')
    fail('root manifest has no version');
  parseSemanticVersion(rootManifest.version);
  const version = rootManifest.version;
  const timestamp = sourceTimestamp(sourceDateEpoch);
  const packageLock = await boundedText(
    resolve(repositoryRoot, 'package-lock.json'),
  );
  const cargoLock = await boundedText(
    resolve(repositoryRoot, 'apps/desktop/src-tauri/Cargo.lock'),
  );
  let npmOutput: string;
  try {
    const result = await execFile(
      'npm',
      ['sbom', '--package-lock-only', '--sbom-format', 'cyclonedx'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: MAX_INPUT_BYTES,
        env: { ...process.env, NO_COLOR: '1' },
      },
    );
    npmOutput = result.stdout;
  } catch {
    return fail('npm dependency inventory failed');
  }
  const npmSbom = normalizeNpmSbom(
    parseObject(npmOutput, 'npm SBOM'),
    sha256(packageLock),
    timestamp,
    repositoryRoot,
  );
  const packages = parseCargoLock(cargoLock);
  const rustSbom = cargoSbom(packages, version, sha256(cargoLock), timestamp);
  const files = [
    `NexaChat-${version}-desktop-cargo.cdx.json`,
    `NexaChat-${version}-source-npm.cdx.json`,
  ];
  await writeNewOrIdentical(
    resolve(outputDirectory, files[0] ?? ''),
    canonicalJson(rustSbom),
  );
  await writeNewOrIdentical(
    resolve(outputDirectory, files[1] ?? ''),
    canonicalJson(npmSbom),
  );
  return {
    version,
    npmComponents: Array.isArray(npmSbom.components)
      ? npmSbom.components.length
      : 0,
    cargoComponents: packages.filter(
      (pkg) => !(pkg.name === 'nexa-desktop' && pkg.version === version),
    ).length,
    files,
  };
}

function options(args: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const argument of args) {
    const match = /^(--[a-z-]+)=(.+)$/.exec(argument);
    if (!match?.[1] || !match[2] || parsed.has(match[1]))
      fail('invalid or duplicate option');
    parsed.set(match[1], match[2]);
  }
  return parsed;
}

async function main(args: string[]): Promise<void> {
  const [command, ...rawOptions] = args;
  if (command !== 'generate') fail('expected generate command');
  const parsed = options(rawOptions);
  for (const key of parsed.keys()) {
    if (
      ![
        '--repository-root',
        '--output-directory',
        '--source-date-epoch',
      ].includes(key)
    ) {
      fail(`unsupported option: ${key}`);
    }
  }
  const outputDirectory = parsed.get('--output-directory');
  const sourceDateEpoch = parsed.get('--source-date-epoch');
  if (!outputDirectory || !sourceDateEpoch)
    fail('missing required SBOM option');
  const summary = await generateSboms(
    parsed.get('--repository-root') ?? REPOSITORY_ROOT,
    outputDirectory,
    Number(sourceDateEpoch),
  );
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, status: 'ok', ...summary })}\n`,
  );
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof SbomValidationError
        ? error.message
        : 'unexpected failure';
    process.stderr.write(`sbom_generation_failed: ${message}\n`);
    process.exitCode = 1;
  });
}
