import { Buffer } from 'node:buffer';
import {
  lstat,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { posix } from 'node:path';
import process from 'node:process';

const MAX_DOCUMENTS = 256;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MANIFEST = '.nexachat-docs-manifest';
const GENERATED_PAGES = ['Home.md', '_Sidebar.md'];

export class WikiExportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WikiExportError';
    this.code = code;
  }
}

function fail(code) {
  throw new WikiExportError(code);
}

function pageSlug(sourcePath) {
  if (
    sourcePath.length > 180 ||
    !/^[a-z0-9][a-z0-9._/-]*\.md$/.test(sourcePath)
  ) {
    fail('invalid_source_path');
  }
  const withoutExtension = sourcePath.slice(0, -3);
  const words = withoutExtension
    .split('/')
    .flatMap((segment) => segment.split(/[-_]/))
    .filter(Boolean)
    .map((word) =>
      /^\d/.test(word)
        ? word
        : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`,
    );
  const slug = `${words.join('-')}.md`;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,179}\.md$/.test(slug)) {
    fail('invalid_page_slug');
  }
  return slug;
}

function linkTitle(markdown, sourcePath) {
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  if (!heading || heading.length > 160 || /[\0\r\n]/.test(heading)) {
    fail(`invalid_document_title:${sourcePath}`);
  }
  return heading.replaceAll('[', '').replaceAll(']', '');
}

function groupTitle(sourcePath) {
  const group = sourcePath.split('/')[0] ?? '';
  if (!group) fail('invalid_source_group');
  return `${group.slice(0, 1).toUpperCase()}${group.slice(1)}`;
}

async function regularDirectory(path, context) {
  let details;
  try {
    details = await lstat(path);
  } catch {
    return fail(`missing_${context}`);
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    fail(`invalid_${context}`);
  }
}

async function collectDocuments(sourceDirectory) {
  const documents = [];
  let totalBytes = 0;

  async function walk(directory, prefix, depth) {
    if (depth > 8) fail('source_depth_exceeded');
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const sourcePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail('source_symlink_rejected');
      if (entry.isDirectory()) {
        await walk(path, sourcePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const details = await lstat(path);
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        details.size <= 0 ||
        details.size > MAX_DOCUMENT_BYTES
      ) {
        fail(`invalid_document:${sourcePath}`);
      }
      totalBytes += details.size;
      if (totalBytes > MAX_TOTAL_BYTES) fail('documentation_too_large');
      documents.push({
        sourcePath,
        markdown: await readFile(path, 'utf8'),
      });
      if (documents.length > MAX_DOCUMENTS) fail('too_many_documents');
    }
  }

  await walk(sourceDirectory, '', 0);
  if (documents.length === 0) fail('no_documents');
  return documents;
}

function rewriteLinks(markdown, sourcePath, pageBySource) {
  return markdown.replace(
    /(!?\[[^\]\r\n]*\]\()([^\s)]+)([^)\r\n]*\))/g,
    (match, prefix, destination, suffix) => {
      if (
        destination.startsWith('#') ||
        /^[a-z][a-z0-9+.-]*:/i.test(destination) ||
        destination.startsWith('//')
      ) {
        return match;
      }
      const hashIndex = destination.indexOf('#');
      const path =
        hashIndex === -1 ? destination : destination.slice(0, hashIndex);
      const anchor = hashIndex === -1 ? '' : destination.slice(hashIndex);
      if (!path.endsWith('.md')) return match;
      if (isAbsolute(path) || path.includes('\\')) fail('unsafe_document_link');
      const target = posix.normalize(
        posix.join(posix.dirname(sourcePath), path),
      );
      if (target === '..' || target.startsWith('../')) {
        fail(`document_link_outside_docs:${sourcePath}`);
      }
      const targetPage = pageBySource.get(target);
      if (!targetPage) fail(`missing_document_link:${sourcePath}`);
      return `${prefix}${targetPage.slice(0, -3)}${anchor}${suffix}`;
    },
  );
}

function generatedPage(sourcePath, markdown, pageBySource) {
  const rewritten = rewriteLinks(markdown, sourcePath, pageBySource).trimEnd();
  return `<!-- Generated from docs/${sourcePath}; edit the repository source, not this wiki page. -->\n\n${rewritten}\n`;
}

function navigationPages(records, repository, branch) {
  const grouped = new Map();
  for (const record of records) {
    const group = groupTitle(record.sourcePath);
    const groupRecords = grouped.get(group) ?? [];
    groupRecords.push(record);
    grouped.set(group, groupRecords);
  }
  const groups = [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right, 'en'),
  );
  const sections = groups
    .map(
      ([group, entries]) =>
        `## ${group}\n\n${entries
          .map((entry) => `- [${entry.title}](${entry.page.slice(0, -3)})`)
          .join('\n')}`,
    )
    .join('\n\n');
  const sidebarSections = groups
    .map(
      ([group, entries]) =>
        `### ${group}\n${entries
          .map((entry) => `- [${entry.title}](${entry.page.slice(0, -3)})`)
          .join('\n')}`,
    )
    .join('\n\n');
  const sourceUrl = `https://github.com/${repository}/tree/${branch}/docs`;
  return {
    'Home.md': `<!-- Generated by tools/wiki/export.mjs. -->\n\n# Nexa Chat documentation\n\nThese pages are published from the repository's [\`docs/\` directory](${sourceUrl}). Edit and review documentation in the main repository; changes made directly to generated wiki pages will be replaced.\n\n${sections}\n`,
    '_Sidebar.md': `<!-- Generated by tools/wiki/export.mjs. -->\n\n**[Nexa Chat documentation](Home)**\n\n${sidebarSections}\n`,
  };
}

function safeManagedPage(value) {
  return (
    value.length <= 183 &&
    /^(?:Home|_Sidebar|[A-Za-z0-9][A-Za-z0-9.-]{0,179})\.md$/.test(value)
  );
}

async function previousManifest(destinationDirectory) {
  const path = resolve(destinationDirectory, MANIFEST);
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT')
      return [];
    throw error;
  }
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size > MAX_MANIFEST_BYTES
  ) {
    fail('invalid_previous_manifest');
  }
  const values = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  if (
    values.some((value) => !safeManagedPage(value)) ||
    new Set(values).size !== values.length ||
    JSON.stringify(values) !== JSON.stringify([...values].sort())
  ) {
    fail('invalid_previous_manifest');
  }
  return values;
}

async function writeAtomic(path, contents) {
  const temporary = `${path}.wiki-export.tmp`;
  await writeFile(temporary, contents, {
    encoding: 'utf8',
    flag: 'w',
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function exportWiki({
  sourceDirectory,
  destinationDirectory,
  repository,
  branch = 'main',
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    fail('invalid_repository');
  }
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(branch) || branch.includes('..')) {
    fail('invalid_branch');
  }
  const source = resolve(sourceDirectory);
  const destination = resolve(destinationDirectory);
  await regularDirectory(source, 'source_directory');
  await regularDirectory(destination, 'destination_directory');
  if (
    source === destination ||
    source.startsWith(`${destination}${sep}`) ||
    destination.startsWith(`${source}${sep}`)
  ) {
    fail('overlapping_directories');
  }

  const documents = await collectDocuments(source);
  const pageBySource = new Map();
  const caseInsensitivePages = new Set();
  for (const document of documents) {
    const page = pageSlug(document.sourcePath);
    const folded = page.toLocaleLowerCase('en-US');
    if (caseInsensitivePages.has(folded)) fail('duplicate_page_slug');
    caseInsensitivePages.add(folded);
    pageBySource.set(document.sourcePath, page);
  }

  const records = documents
    .map((document) => ({
      ...document,
      page: pageBySource.get(document.sourcePath),
      title: linkTitle(document.markdown, document.sourcePath),
    }))
    .sort((left, right) => left.page.localeCompare(right.page, 'en'));
  const generated = new Map();
  for (const record of records) {
    generated.set(
      record.page,
      generatedPage(record.sourcePath, record.markdown, pageBySource),
    );
  }
  const navigation = navigationPages(records, repository, branch);
  for (const page of GENERATED_PAGES) generated.set(page, navigation[page]);

  const previous = await previousManifest(destination);
  const current = [...generated.keys()].sort();
  for (const page of previous) {
    if (generated.has(page)) continue;
    const path = resolve(destination, page);
    try {
      const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink()) {
        fail('managed_page_not_regular');
      }
      await unlink(path);
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  for (const [page, contents] of generated) {
    await writeAtomic(resolve(destination, page), contents);
  }
  await writeAtomic(resolve(destination, MANIFEST), `${current.join('\n')}\n`);

  const bytes = [...generated.values()].reduce(
    (total, contents) => total + Buffer.byteLength(contents),
    0,
  );
  return {
    schemaVersion: 1,
    documents: documents.length,
    pages: generated.size,
    bytes,
    removedPages: previous.filter((page) => !generated.has(page)).length,
  };
}

function options(arguments_) {
  const parsed = new Map();
  for (const argument of arguments_) {
    const match = /^(--[a-z-]+)=(.+)$/.exec(argument);
    if (!match?.[1] || !match[2] || parsed.has(match[1]))
      fail('invalid_option');
    parsed.set(match[1], match[2]);
  }
  return parsed;
}

async function main(arguments_) {
  const parsed = options(arguments_);
  const allowed = new Set([
    '--source',
    '--destination',
    '--repository',
    '--branch',
  ]);
  if ([...parsed.keys()].some((key) => !allowed.has(key))) {
    fail('unsupported_option');
  }
  for (const required of ['--source', '--destination', '--repository']) {
    if (!parsed.has(required)) fail('missing_option');
  }
  const result = await exportWiki({
    sourceDirectory: parsed.get('--source'),
    destinationDirectory: parsed.get('--destination'),
    repository: parsed.get('--repository'),
    branch: parsed.get('--branch') ?? 'main',
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    const code =
      error instanceof WikiExportError ? error.code : 'unexpected_failure';
    process.stderr.write(`wiki_export_failed: ${code}\n`);
    process.exitCode = 1;
  });
}
