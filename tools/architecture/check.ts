import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceExtension = /\.(?:[cm]?[jt]sx?)$/;
const importPattern =
  /(?:from\s*|import\s*(?:\(\s*)?|require\s*\()\s*['"](@nexa\/[^'"]+)['"]/g;

interface BoundaryException {
  from: string;
  to: string;
  owner: string;
  rationale: string;
  removeAfter: string;
}

interface BoundaryConfig {
  workspaces: Record<string, string[]>;
  exceptions: BoundaryException[];
}

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface Workspace {
  directory: string;
  manifest: Manifest;
}

export async function checkArchitecture(root: string): Promise<string[]> {
  const config = JSON.parse(
    await readFile(join(root, 'architecture-boundaries.json'), 'utf8'),
  ) as BoundaryConfig;
  const workspaces = await discoverWorkspaces(root);
  const names = new Set(workspaces.map((workspace) => workspace.manifest.name));
  const violations = [];
  const graph = new Map<string, Set<string>>();

  for (const [index, exception] of config.exceptions.entries()) {
    for (const field of [
      'from',
      'to',
      'owner',
      'rationale',
      'removeAfter',
    ] as const) {
      if (
        typeof exception[field] !== 'string' ||
        exception[field].trim() === ''
      ) {
        violations.push(
          `exception ${String(index)}: ${field} must be a non-empty string`,
        );
      }
    }
    if (
      typeof exception.removeAfter === 'string' &&
      !/^\d{4}-\d{2}-\d{2}$/.test(exception.removeAfter)
    ) {
      violations.push(
        `exception ${String(index)}: removeAfter must use YYYY-MM-DD`,
      );
    }
  }

  for (const workspace of workspaces) {
    const name = workspace.manifest.name;
    const allowed = new Set(config.workspaces[name] ?? []);
    const declared = localDependencies(workspace.manifest, names);
    graph.set(name, declared);

    if (!(name in config.workspaces)) {
      violations.push(
        `${name}: workspace is missing from architecture-boundaries.json`,
      );
    }
    for (const dependency of declared) {
      if (!allowed.has(dependency) && !isExcepted(config, name, dependency)) {
        violations.push(`${name}: dependency on ${dependency} is not allowed`);
      }
    }

    for (const file of await sourceFiles(workspace.directory)) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        const dependency = packageName(specifier);
        const location = relative(root, file).split(sep).join('/');
        if (!names.has(dependency)) continue;
        if (specifier !== dependency) {
          violations.push(
            `${location}: deep workspace import ${specifier} bypasses the public package entry point`,
          );
        }
        if (dependency !== name && !declared.has(dependency)) {
          violations.push(
            `${location}: ${dependency} is imported but not declared`,
          );
        }
      }
    }
  }

  violations.push(
    ...cycles(graph).map(
      (cycle) => `workspace dependency cycle: ${cycle.join(' -> ')}`,
    ),
  );
  return violations.sort();
}

async function discoverWorkspaces(root: string): Promise<Workspace[]> {
  const result: Workspace[] = [];
  for (const parent of ['apps', 'packages']) {
    const directory = join(root, parent);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workspaceDirectory = join(directory, entry.name);
      const manifest = JSON.parse(
        await readFile(join(workspaceDirectory, 'package.json'), 'utf8'),
      ) as Manifest;
      result.push({ directory: workspaceDirectory, manifest });
    }
  }
  return result;
}

function localDependencies(
  manifest: Manifest,
  names: Set<string>,
): Set<string> {
  const all = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };
  return new Set(Object.keys(all).filter((name) => names.has(name)));
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(path)));
    else if (sourceExtension.test(entry.name)) result.push(path);
  }
  return result;
}

function packageName(specifier: string): string {
  return specifier.split('/').slice(0, 2).join('/');
}

function isExcepted(config: BoundaryConfig, from: string, to: string): boolean {
  return config.exceptions.some(
    (exception) => exception.from === from && exception.to === to,
  );
}

function cycles(graph: Map<string, Set<string>>): string[][] {
  const found: string[][] = [];
  const visited = new Set();
  const active: string[] = [];
  const activeSet = new Set();
  function visit(node: string): void {
    if (activeSet.has(node)) {
      const start = active.indexOf(node);
      found.push([...active.slice(start), node]);
      return;
    }
    if (visited.has(node)) return;
    active.push(node);
    activeSet.add(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    active.pop();
    activeSet.delete(node);
    visited.add(node);
  }
  for (const node of graph.keys()) visit(node);
  return found;
}

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? '.');
  const violations = await checkArchitecture(root);
  if (violations.length) {
    console.error(
      [
        'Architecture boundary violations:',
        ...violations.map((item) => `- ${item}`),
      ].join('\n'),
    );
    process.exitCode = 1;
  } else {
    console.log('Architecture boundaries valid.');
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  await main();
