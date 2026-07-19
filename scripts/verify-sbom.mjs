import { readFile } from 'node:fs/promises';

const [path] = process.argv.slice(2);
if (!path) {
  console.error('usage: verify-sbom.mjs SBOM');
  process.exit(2);
}

const sbom = JSON.parse(await readFile(path, 'utf8'));
const failures = [];
if (sbom.bomFormat !== 'CycloneDX') failures.push('format is not CycloneDX');
if (!/^1\.[5-9]$/u.test(sbom.specVersion ?? ''))
  failures.push('unsupported CycloneDX version');
if (!/^urn:uuid:[0-9a-f-]{36}$/iu.test(sbom.serialNumber ?? ''))
  failures.push('serial number is missing or invalid');
if (
  sbom.metadata?.component?.['bom-ref'] !== 'nexa-chat@0.1.0' ||
  sbom.metadata?.component?.purl !== 'pkg:npm/nexa-chat@0.1.0'
)
  failures.push('root component identity is not nexa-chat@0.1.0');
if (!Array.isArray(sbom.components) || sbom.components.length < 200)
  failures.push('component inventory is incomplete');

const references = new Set();
for (const component of sbom.components ?? []) {
  if (!component.name || !component.version || !component['bom-ref'])
    failures.push('component identity is incomplete');
  if (!component.purl) failures.push(`component ${component.name} has no purl`);
  if (references.has(component['bom-ref']))
    failures.push(`duplicate component reference ${component['bom-ref']}`);
  references.add(component['bom-ref']);
}
for (const dependency of sbom.dependencies ?? []) {
  if (!dependency.ref) failures.push('dependency reference is missing');
  for (const child of dependency.dependsOn ?? []) {
    if (
      !references.has(child) &&
      child !== sbom.metadata?.component?.['bom-ref']
    )
      failures.push(`dependency points to missing component ${child}`);
  }
}

if (failures.length) {
  for (const failure of [...new Set(failures)])
    console.error(`sbom_validation_error: ${failure}`);
  process.exit(1);
}
console.log(
  `CycloneDX SBOM validated: ${sbom.components.length} versioned components.`,
);
