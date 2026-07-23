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
const REPOSITORY_ONLY_DOCUMENT =
  /(?:^|\/)(?:audit|performance-audit)-\d{4}-\d{2}-\d{2}\.md$/u;
const NAVIGATION = [
  {
    groups: ['Architecture'],
    page: 'Architecture.md',
    title: 'Architecture',
    description:
      'Design decisions, service boundaries, contracts, real-time behavior, and the desktop shell.',
  },
  {
    groups: ['Operations'],
    page: 'Operations-And-Deployment.md',
    title: 'Operations and deployment',
    description:
      'Local development, production deployment, containers, data services, observability, and recovery.',
  },
  {
    groups: ['Security', 'Privacy'],
    page: 'Security-And-Privacy.md',
    title: 'Security and privacy',
    description:
      'Threat models, security controls, credential handling, privacy commitments, and data lifecycle guidance.',
  },
  {
    groups: ['Releases'],
    page: 'Releases-And-Support.md',
    title: 'Releases and support',
    description:
      'Versioning, release validation, upgrades, rollback, artifact integrity, and compatibility policy.',
  },
];
const GENERATED_PAGES = [
  'Home.md',
  '_Sidebar.md',
  ...NAVIGATION.map((entry) => entry.page),
];

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

function sourceGroup(sourcePath) {
  return groupTitle(sourcePath).replace(/\.md$/u, '');
}

function publishToWiki(sourcePath) {
  return !REPOSITORY_ONLY_DOCUMENT.test(sourcePath);
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

function rewriteLinks(
  markdown,
  sourcePath,
  pageBySource,
  sourcePaths,
  repository,
  branch,
) {
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
      if (isAbsolute(path) || path.includes('\\')) fail('unsafe_document_link');
      const target = posix.normalize(
        posix.join(posix.dirname(sourcePath), path),
      );
      if (
        path.endsWith('.md') &&
        target !== '..' &&
        !target.startsWith('../')
      ) {
        const targetPage = pageBySource.get(target);
        if (targetPage) {
          return `${prefix}${targetPage.slice(0, -3)}${anchor}${suffix}`;
        }
        if (!sourcePaths.has(target)) {
          fail(`missing_document_link:${sourcePath}`);
        }
      }

      const repositoryPath = posix.normalize(
        posix.join('docs', posix.dirname(sourcePath), path),
      );
      if (
        repositoryPath === '..' ||
        repositoryPath.startsWith('../') ||
        repositoryPath.startsWith('/')
      ) {
        fail(`document_link_outside_repository:${sourcePath}`);
      }
      return `${prefix}https://github.com/${repository}/blob/${branch}/${repositoryPath}${anchor}${suffix}`;
    },
  );
}

function generatedPage(
  sourcePath,
  markdown,
  pageBySource,
  sourcePaths,
  repository,
  branch,
) {
  const rewritten = rewriteLinks(
    markdown,
    sourcePath,
    pageBySource,
    sourcePaths,
    repository,
    branch,
  ).trimEnd();
  return `<!-- Generated from docs/${sourcePath}; edit the repository source, not this wiki page. -->\n\n${rewritten}\n`;
}

function navigationPages(records, repository, branch) {
  const recordsBySource = new Map(
    records.map((record) => [record.sourcePath, record]),
  );
  const pageLink = (record) => `[${record.title}](${record.page.slice(0, -3)})`;
  const categoryEntries = NAVIGATION.map((category) => ({
    ...category,
    records: records.filter((record) =>
      category.groups.includes(sourceGroup(record.sourcePath)),
    ),
  })).filter((category) => category.records.length > 0);
  const categorizedGroups = new Set(
    categoryEntries.flatMap((category) => category.groups),
  );
  const uncategorized = records.filter(
    (record) => !categorizedGroups.has(sourceGroup(record.sourcePath)),
  );
  const startHere = [
    'operations/development.md',
    'operations/production-deployment.md',
    'operations/backup-and-restore.md',
    'security/threat-model.md',
    'releases/support-compatibility.md',
  ]
    .map((sourcePath) => recordsBySource.get(sourcePath))
    .filter(Boolean);
  const sourceUrl = `https://github.com/${repository}/tree/${branch}/docs`;
  const pages = new Map();
  for (const category of categoryEntries) {
    pages.set(
      category.page,
      `<!-- Generated by tools/wiki/export.mjs. -->\n\n# ${category.title}\n\n${category.description}\n\nThese pages are published from [\`docs/\`](${sourceUrl}). Edit their repository source, not this generated index.\n\n## Pages\n\n${category.records.map((record) => `- ${pageLink(record)}`).join('\n')}\n`,
    );
  }
  const homeSections = [
    startHere.length
      ? `## Start here\n\n${startHere.map((record) => `- ${pageLink(record)}`).join('\n')}`
      : '',
    `## Browse by topic\n\n${categoryEntries
      .map(
        (category) =>
          `- [${category.title}](${category.page.slice(0, -3)}) — ${category.description}`,
      )
      .concat(uncategorized.map((record) => `- ${pageLink(record)}`))
      .join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  pages.set(
    'Home.md',
    `<!-- Generated by tools/wiki/export.mjs. -->\n\n# NexaChat documentation\n\nDetailed project guidance is published from the repository's [\`docs/\` directory](${sourceUrl}). Edit and review the repository source; direct edits to generated wiki pages are replaced on the next successful publication.\n\n${homeSections}\n`,
  );
  pages.set(
    '_Sidebar.md',
    `<!-- Generated by tools/wiki/export.mjs. -->\n\n**[NexaChat documentation](Home)**\n\n- [Home](Home)\n${categoryEntries
      .map((category) => `- [${category.title}](${category.page.slice(0, -3)})`)
      .concat(uncategorized.map((record) => `- ${pageLink(record)}`))
      .join('\n')}\n`,
  );
  return pages;
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
  const publishedDocuments = documents.filter((document) =>
    publishToWiki(document.sourcePath),
  );
  const sourcePaths = new Set(documents.map((document) => document.sourcePath));
  const pageBySource = new Map();
  const caseInsensitivePages = new Set();
  const reservedPages = new Set(
    GENERATED_PAGES.map((page) => page.toLocaleLowerCase('en-US')),
  );
  for (const document of publishedDocuments) {
    const page = pageSlug(document.sourcePath);
    const folded = page.toLocaleLowerCase('en-US');
    if (reservedPages.has(folded)) fail('reserved_page_slug');
    if (caseInsensitivePages.has(folded)) fail('duplicate_page_slug');
    caseInsensitivePages.add(folded);
    pageBySource.set(document.sourcePath, page);
  }

  const records = publishedDocuments
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
      generatedPage(
        record.sourcePath,
        record.markdown,
        pageBySource,
        sourcePaths,
        repository,
        branch,
      ),
    );
  }
  const navigation = navigationPages(records, repository, branch);
  for (const [page, contents] of navigation) generated.set(page, contents);

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
    documents: publishedDocuments.length,
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
