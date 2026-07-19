import { access, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredArtifacts = [
  'apps/server/dist-production/main.mjs',
  'apps/server/dist-production/migrate.mjs',
  'apps/web/dist/index.html',
];
const runtimeManifest = JSON.parse(
  await readFile(
    resolve(repositoryRoot, 'apps/server/runtime/package.json'),
    'utf8',
  ),
);
const repositoryLock = JSON.parse(
  await readFile(resolve(repositoryRoot, 'package-lock.json'), 'utf8'),
);
const runtimeLock = JSON.parse(
  await readFile(
    resolve(repositoryRoot, 'apps/server/runtime/package-lock.json'),
    'utf8',
  ),
);
const runtimeDependencies = new Set(
  Object.keys(runtimeManifest.dependencies ?? {}),
);
const importedRuntimeDependencies = new Set();
const repositoryPackages = repositoryLock.packages ?? {};
const runtimePackages = runtimeLock.packages ?? {};
const runtimeRootPackage = runtimePackages[''];
const comparedPackagePairs = new Set();
const reachableRuntimePackages = new Set();

if (repositoryLock.lockfileVersion !== 3 || runtimeLock.lockfileVersion !== 3) {
  throw new Error(
    'Production dependency verification requires npm lockfile v3',
  );
}

if (!runtimeRootPackage) {
  throw new Error('Runtime lock is missing its root package');
}

if (
  Object.keys(runtimeManifest.devDependencies ?? {}).length > 0 ||
  Object.keys(runtimeRootPackage.devDependencies ?? {}).length > 0
) {
  throw new Error(
    'Runtime manifest and lock must not contain dev dependencies',
  );
}

const manifestDependencyEntries = Object.entries(
  runtimeManifest.dependencies ?? {},
).sort(([left], [right]) => left.localeCompare(right));
const lockedDependencyEntries = Object.entries(
  runtimeRootPackage.dependencies ?? {},
).sort(([left], [right]) => left.localeCompare(right));

if (
  JSON.stringify(manifestDependencyEntries) !==
  JSON.stringify(lockedDependencyEntries)
) {
  throw new Error('Runtime manifest dependencies do not match its lock root');
}

function lockedPackageName(packagePath) {
  const marker = 'node_modules/';
  const packageTail = packagePath.slice(
    packagePath.lastIndexOf(marker) + marker.length,
  );
  const [first, second] = packageTail.split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

function packageIdentity(packagePath, packageRecord) {
  return {
    name: packageRecord.name ?? lockedPackageName(packagePath),
    version: packageRecord.version ?? null,
    resolved: packageRecord.resolved ?? null,
    integrity: packageRecord.integrity ?? null,
  };
}

function packageIdentityLabel(packagePath, packageRecord) {
  if (!packagePath || !packageRecord) return '<missing>';
  const identity = packageIdentity(packagePath, packageRecord);
  return `${identity.name}@${identity.version ?? '<missing version>'}`;
}

function productionEdges(packageRecord) {
  const edges = new Map();

  for (const [name, specifier] of Object.entries(
    packageRecord.dependencies ?? {},
  )) {
    edges.set(name, { type: 'dependency', specifier, required: true });
  }
  for (const [name, specifier] of Object.entries(
    packageRecord.optionalDependencies ?? {},
  )) {
    edges.set(name, { type: 'optional', specifier, required: false });
  }
  for (const [name, specifier] of Object.entries(
    packageRecord.peerDependencies ?? {},
  )) {
    if (edges.has(name)) continue;
    const optional =
      packageRecord.peerDependenciesMeta?.[name]?.optional === true;
    edges.set(name, {
      type: optional ? 'peer-optional' : 'peer',
      specifier,
      required: !optional,
    });
  }

  return edges;
}

function resolveLockedDependency(packages, fromPackagePath, dependency) {
  let currentPackagePath = fromPackagePath;

  while (currentPackagePath) {
    const nestedCandidate = `${currentPackagePath}/node_modules/${dependency}`;
    if (packages[nestedCandidate]) return nestedCandidate;

    const parentMarker = currentPackagePath.lastIndexOf('/node_modules/');
    if (parentMarker < 0) break;
    currentPackagePath = currentPackagePath.slice(0, parentMarker);
  }

  const rootCandidate = `node_modules/${dependency}`;
  return packages[rootCandidate] ? rootCandidate : undefined;
}

function compareProductionClosure(
  repositoryPackagePath,
  runtimePackagePath,
  dependencyChain,
  required = true,
) {
  if (runtimePackagePath) reachableRuntimePackages.add(runtimePackagePath);

  if (!repositoryPackagePath && !runtimePackagePath) {
    if (required) {
      throw new Error(
        `Required production dependency is absent from both locks: ${dependencyChain}`,
      );
    }
    return;
  }

  const repositoryPackage = repositoryPackagePath
    ? repositoryPackages[repositoryPackagePath]
    : undefined;
  const runtimePackage = runtimePackagePath
    ? runtimePackages[runtimePackagePath]
    : undefined;

  if (!repositoryPackage || !runtimePackage) {
    throw new Error(
      `Production dependency differs at ${dependencyChain}: ${packageIdentityLabel(repositoryPackagePath, repositoryPackage)} in the repository lock, ${packageIdentityLabel(runtimePackagePath, runtimePackage)} in the runtime lock`,
    );
  }

  const pairKey = `${repositoryPackagePath}\0${runtimePackagePath}`;
  if (comparedPackagePairs.has(pairKey)) return;
  comparedPackagePairs.add(pairKey);

  const repositoryIdentity = packageIdentity(
    repositoryPackagePath,
    repositoryPackage,
  );
  const runtimeIdentity = packageIdentity(runtimePackagePath, runtimePackage);
  if (JSON.stringify(repositoryIdentity) !== JSON.stringify(runtimeIdentity)) {
    throw new Error(
      `Production dependency differs at ${dependencyChain}: ${packageIdentityLabel(repositoryPackagePath, repositoryPackage)} in the repository lock, ${packageIdentityLabel(runtimePackagePath, runtimePackage)} in the runtime lock`,
    );
  }

  const repositoryEdges = productionEdges(repositoryPackage);
  const runtimeEdges = productionEdges(runtimePackage);
  const edgeNames = [
    ...new Set([...repositoryEdges.keys(), ...runtimeEdges.keys()]),
  ].sort();

  for (const dependency of edgeNames) {
    const repositoryEdge = repositoryEdges.get(dependency);
    const runtimeEdge = runtimeEdges.get(dependency);
    const nextChain = `${dependencyChain} -> ${dependency}`;

    if (
      !repositoryEdge ||
      !runtimeEdge ||
      repositoryEdge.type !== runtimeEdge.type ||
      repositoryEdge.specifier !== runtimeEdge.specifier
    ) {
      throw new Error(`Production dependency edge differs at ${nextChain}`);
    }

    compareProductionClosure(
      resolveLockedDependency(
        repositoryPackages,
        repositoryPackagePath,
        dependency,
      ),
      resolveLockedDependency(runtimePackages, runtimePackagePath, dependency),
      nextChain,
      repositoryEdge.required,
    );
  }
}

for (const [dependency, declaredVersion] of Object.entries(
  runtimeManifest.dependencies ?? {},
)) {
  const repositoryPackagePath = resolveLockedDependency(
    repositoryPackages,
    '',
    dependency,
  );
  const runtimePackagePath = resolveLockedDependency(
    runtimePackages,
    '',
    dependency,
  );
  const repositoryVersion = repositoryPackagePath
    ? repositoryPackages[repositoryPackagePath]?.version
    : undefined;
  const runtimeVersion = runtimePackagePath
    ? runtimePackages[runtimePackagePath]?.version
    : undefined;
  const runtimeRootVersion = runtimeRootPackage.dependencies?.[dependency];
  if (
    declaredVersion !== repositoryVersion ||
    declaredVersion !== runtimeVersion ||
    declaredVersion !== runtimeRootVersion
  ) {
    throw new Error(
      `Runtime dependency ${dependency} does not match the tested repository lock`,
    );
  }

  compareProductionClosure(
    repositoryPackagePath,
    runtimePackagePath,
    dependency,
  );
}

for (const [packagePath, packageRecord] of Object.entries(runtimePackages)) {
  if (!packagePath) continue;
  if (packageRecord.dev === true) {
    throw new Error(`Runtime lock contains a dev-only package: ${packagePath}`);
  }
  if (
    packageRecord.link === true ||
    !packagePath.startsWith('node_modules/') ||
    packageRecord.resolved?.startsWith('file:')
  ) {
    throw new Error(
      `Runtime lock contains a local or workspace package: ${packagePath}`,
    );
  }
  if (!reachableRuntimePackages.has(packagePath)) {
    throw new Error(
      `Runtime lock contains an unreachable production package: ${packagePath}`,
    );
  }
}

for (const artifact of requiredArtifacts) {
  const absolutePath = resolve(repositoryRoot, artifact);
  await access(absolutePath);
  if ((await stat(absolutePath)).size === 0) {
    throw new Error(`Production artifact is empty: ${artifact}`);
  }
}

for (const entrypoint of ['main.mjs', 'migrate.mjs']) {
  const source = await readFile(
    resolve(repositoryRoot, 'apps/server/dist-production', entrypoint),
    'utf8',
  );
  const forbiddenImport = source.match(/(?:from\s+|import\s*\()(["'])@nexa\//);
  if (forbiddenImport) {
    throw new Error(
      `${entrypoint} retains a workspace import that cannot run without TypeScript sources`,
    );
  }
  if (/(?:from\s+|import\s*\()(["'])[^"']+\.tsx?\1/.test(source)) {
    throw new Error(`${entrypoint} retains a TypeScript runtime import`);
  }
  for (const match of source.matchAll(
    /(?:from\s+|import\s*\()(["'])([^"']+)\1/g,
  )) {
    const specifier = match[2];
    if (
      !specifier ||
      specifier.startsWith('.') ||
      specifier.startsWith('node:')
    )
      continue;
    const packageName = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    if (!runtimeDependencies.has(packageName)) {
      throw new Error(
        `${entrypoint} imports undeclared runtime dependency ${packageName}`,
      );
    }
    importedRuntimeDependencies.add(packageName);
  }
}

for (const dependency of runtimeDependencies) {
  if (!importedRuntimeDependencies.has(dependency)) {
    throw new Error(
      `Runtime manifest contains unused dependency ${dependency}`,
    );
  }
}

process.stdout.write(
  'Production artifacts and complete runtime dependency closure match the tested repository lock.\n',
);
