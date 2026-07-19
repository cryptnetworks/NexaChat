import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const [directory, expectedRevision, expectedVersion] = process.argv.slice(2);
if (!directory || !expectedRevision || !expectedVersion) {
  console.error(
    'usage: verify-build-metadata.mjs DIRECTORY EXPECTED_REVISION EXPECTED_VERSION',
  );
  process.exit(2);
}

const expectedTargets = new Set([
  'edge-runtime',
  'object-storage-runtime',
  'postgres-runtime',
  'server-runtime',
]);
const files = (await readdir(directory)).filter((file) =>
  file.endsWith('.json'),
);
const failures = [];
if (files.length !== expectedTargets.size)
  failures.push(
    `expected ${expectedTargets.size} metadata files, found ${files.length}`,
  );

for (const file of files) {
  const value = JSON.parse(await readFile(join(directory, file), 'utf8'));
  const provenance = value['buildx.build.provenance'];
  const parameters = provenance?.invocation?.parameters?.args ?? {};
  const target = parameters.target;
  if (!/^sha256:[0-9a-f]{64}$/u.test(value['containerimage.digest'] ?? ''))
    failures.push(`${file}: image digest is invalid`);
  if (provenance?.buildType !== 'https://mobyproject.org/buildkit@v1')
    failures.push(`${file}: BuildKit provenance is missing`);
  if (!expectedTargets.delete(target))
    failures.push(`${file}: unexpected or duplicate target ${String(target)}`);
  if (parameters['build-arg:NEXA_IMAGE_REVISION'] !== expectedRevision)
    failures.push(`${file}: revision build argument does not match`);
  if (parameters['build-arg:NEXA_IMAGE_VERSION'] !== expectedVersion)
    failures.push(`${file}: version build argument does not match`);
  const materials = provenance?.materials;
  if (!Array.isArray(materials) || materials.length === 0)
    failures.push(`${file}: provenance materials are missing`);
  for (const material of materials ?? []) {
    if (!/^[0-9a-f]{64}$/u.test(material.digest?.sha256 ?? ''))
      failures.push(`${file}: material digest is invalid`);
  }
  if (!basename(file, '.json')) failures.push(`${file}: invalid metadata name`);
}
for (const target of expectedTargets)
  failures.push(`missing metadata for ${target}`);

if (failures.length) {
  for (const failure of failures)
    console.error(`build_provenance_error: ${failure}`);
  process.exit(1);
}
console.log('BuildKit provenance and immutable material digests validated.');
