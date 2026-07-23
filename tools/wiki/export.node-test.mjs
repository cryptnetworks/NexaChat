import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { exportWiki, WikiExportError } from './export.mjs';

const temporaryDirectories = [];

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'nexachat-wiki-export-'));
  temporaryDirectories.push(root);
  const source = resolve(root, 'docs');
  const destination = resolve(root, 'wiki');
  await Promise.all([
    mkdir(resolve(source, 'architecture'), { recursive: true }),
    mkdir(resolve(source, 'operations'), { recursive: true }),
    mkdir(destination),
  ]);
  await writeFile(
    resolve(source, 'architecture', 'overview.md'),
    '# Architecture overview\n\nSee the [runbook](../operations/recovery.md#restart), [security reporting](../../SECURITY.md#private-report), [repository ownership](../../.github/CODEOWNERS), and [benchmark evidence](../operations/performance-audit-2026-01-01.md).\n',
  );
  await writeFile(
    resolve(source, 'operations', 'recovery.md'),
    '# Recovery runbook\n\nExternal [guidance](https://example.test/guide).\n',
  );
  await writeFile(
    resolve(source, 'accessibility.md'),
    '# Accessibility guide\n\nKeyboard-first interface notes.\n',
  );
  await writeFile(
    resolve(source, 'operations', 'performance-audit-2026-01-01.md'),
    '# Performance audit\n\nRepository-only benchmark evidence.\n',
  );
  return { root, source, destination };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('exports deterministic flat pages, navigation, and rewritten links', async () => {
  const { destination, source } = await fixture();
  await writeFile(resolve(destination, 'Home.md'), 'Old placeholder\n');
  await writeFile(resolve(destination, 'Manual.md'), 'Preserve me\n');
  await writeFile(resolve(destination, 'Removed.md'), 'Old generated page\n');
  await writeFile(
    resolve(destination, '.nexachat-docs-manifest'),
    'Home.md\nRemoved.md\n',
  );

  const result = await exportWiki({
    sourceDirectory: source,
    destinationDirectory: destination,
    repository: 'cryptnetworks/NexaChat',
  });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.documents, 3);
  assert.equal(result.pages, 7);
  assert.equal(result.removedPages, 1);
  assert.ok(result.bytes > 0);
  const files = (await readdir(destination)).sort();
  assert.deepEqual(files, [
    '.nexachat-docs-manifest',
    'Accessibility.md',
    'Architecture-Overview.md',
    'Architecture.md',
    'Home.md',
    'Manual.md',
    'Operations-And-Deployment.md',
    'Operations-Recovery.md',
    '_Sidebar.md',
  ]);
  const architecture = await readFile(
    resolve(destination, 'Architecture-Overview.md'),
    'utf8',
  );
  assert.match(architecture, /\(Operations-Recovery#restart\)/);
  assert.match(
    architecture,
    /\(https:\/\/github\.com\/cryptnetworks\/NexaChat\/blob\/main\/SECURITY\.md#private-report\)/,
  );
  assert.match(
    architecture,
    /\(https:\/\/github\.com\/cryptnetworks\/NexaChat\/blob\/main\/\.github\/CODEOWNERS\)/,
  );
  assert.match(
    architecture,
    /\(https:\/\/github\.com\/cryptnetworks\/NexaChat\/blob\/main\/docs\/operations\/performance-audit-2026-01-01\.md\)/,
  );
  assert.ok(!files.includes('Operations-Performance-Audit-2026-01-01.md'));
  assert.doesNotMatch(architecture, /\.\.\/operations/);
  const home = await readFile(resolve(destination, 'Home.md'), 'utf8');
  assert.match(home, /# NexaChat documentation/);
  assert.match(home, /\[Architecture\]\(Architecture\)/);
  assert.match(
    home,
    /\[Operations and deployment\]\(Operations-And-Deployment\)/,
  );
  assert.match(home, /- \[Accessibility guide\]\(Accessibility\)/);
  assert.match(
    await readFile(resolve(destination, 'Architecture.md'), 'utf8'),
    /- \[Architecture overview\]\(Architecture-Overview\)/,
  );
  const sidebar = await readFile(resolve(destination, '_Sidebar.md'), 'utf8');
  assert.match(sidebar, /\[Architecture\]\(Architecture\)/);
  assert.match(sidebar, /- \[Accessibility guide\]\(Accessibility\)/);
  assert.doesNotMatch(sidebar, /Architecture overview/);
  assert.equal(
    await readFile(resolve(destination, 'Manual.md'), 'utf8'),
    'Preserve me\n',
  );

  const firstSnapshot = await Promise.all(
    files.map(async (file) => [
      file,
      await readFile(resolve(destination, file), 'utf8'),
    ]),
  );
  await exportWiki({
    sourceDirectory: source,
    destinationDirectory: destination,
    repository: 'cryptnetworks/NexaChat',
  });
  const secondSnapshot = await Promise.all(
    files.map(async (file) => [
      file,
      await readFile(resolve(destination, file), 'utf8'),
    ]),
  );
  assert.deepEqual(secondSnapshot, firstSnapshot);
});

test('fails closed for broken internal links and unsafe prior manifests', async () => {
  const broken = await fixture();
  await writeFile(
    resolve(broken.source, 'architecture', 'overview.md'),
    '# Architecture overview\n\n[Missing](missing.md)\n',
  );
  await assert.rejects(
    exportWiki({
      sourceDirectory: broken.source,
      destinationDirectory: broken.destination,
      repository: 'cryptnetworks/NexaChat',
    }),
    new WikiExportError('missing_document_link:architecture/overview.md'),
  );

  const unsafe = await fixture();
  await writeFile(
    resolve(unsafe.destination, '.nexachat-docs-manifest'),
    '../outside.md\n',
  );
  await assert.rejects(
    exportWiki({
      sourceDirectory: unsafe.source,
      destinationDirectory: unsafe.destination,
      repository: 'cryptnetworks/NexaChat',
    }),
    new WikiExportError('invalid_previous_manifest'),
  );
});

test('rejects source symlinks instead of following them', async () => {
  const { destination, root, source } = await fixture();
  const outside = resolve(root, 'private.md');
  await writeFile(outside, '# Private\n');
  await symlink(outside, resolve(source, 'private.md'));
  await assert.rejects(
    exportWiki({
      sourceDirectory: source,
      destinationDirectory: destination,
      repository: 'cryptnetworks/NexaChat',
    }),
    new WikiExportError('source_symlink_rejected'),
  );
});
