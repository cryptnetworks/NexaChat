import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyReleasePlan,
  checkReleaseState,
  compareSemanticVersions,
  parseSemanticVersion,
  prepareRelease,
  ReleaseValidationError,
  summarizePlan,
} from './versioning.js';

const temporaryRoots: string[] = [];

async function fixture(
  fragmentOverrides: Record<string, unknown> = {},
): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'nexa-release-'));
  temporaryRoots.push(root);
  for (const directory of [
    'apps/server',
    'apps/desktop/src-tauri',
    'packages/domain',
    '.changes',
    'release',
  ]) {
    await mkdir(resolve(root, directory), { recursive: true });
  }
  const manifests = {
    'package.json': {
      name: 'nexa-chat',
      version: '0.1.0',
      private: true,
      workspaces: ['apps/*', 'packages/*'],
    },
    'apps/server/package.json': {
      name: '@nexa/server',
      version: '0.1.0',
      private: true,
      dependencies: { '@nexa/domain': '0.1.0' },
    },
    'packages/domain/package.json': {
      name: '@nexa/domain',
      version: '0.1.0',
      private: true,
    },
  };
  for (const [path, value] of Object.entries(manifests)) {
    await writeFile(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);
  }
  await writeFile(
    resolve(root, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'nexa-chat',
        version: '0.1.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'nexa-chat', version: '0.1.0' },
          'apps/server': {
            name: '@nexa/server',
            version: '0.1.0',
            dependencies: { '@nexa/domain': '0.1.0' },
          },
          'packages/domain': { name: '@nexa/domain', version: '0.1.0' },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    resolve(root, 'apps/desktop/package.json'),
    '{\n  "name": "@nexa/desktop",\n  "version": "0.1.0",\n  "private": true\n}\n',
  );
  const lock = JSON.parse(
    await readFile(resolve(root, 'package-lock.json'), 'utf8'),
  ) as {
    packages: Record<string, unknown>;
  };
  lock.packages['apps/desktop'] = {
    name: '@nexa/desktop',
    version: '0.1.0',
  };
  await writeFile(
    resolve(root, 'package-lock.json'),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  await writeFile(
    resolve(root, 'apps/desktop/src-tauri/Cargo.toml'),
    '[package]\nname = "nexa-desktop"\nversion = "0.1.0"\n',
  );
  await writeFile(
    resolve(root, 'apps/desktop/src-tauri/Cargo.lock'),
    'version = 4\n\n[[package]]\nname = "nexa-desktop"\nversion = "0.1.0"\n',
  );
  await writeFile(
    resolve(root, 'apps/desktop/src-tauri/tauri.conf.json'),
    '{\n  "version": "0.1.0"\n}\n',
  );
  await writeFile(
    resolve(root, 'release/upgrade-policy.json'),
    '{\n  "targetVersion": "0.1.0"\n}\n',
  );
  await writeFile(
    resolve(root, 'release/candidate-policy.json'),
    '{\n  "targetVersion": "0.1.0"\n}\n',
  );
  await writeFile(
    resolve(root, 'release/update-policy.json'),
    '{\n  "targetVersion": "0.1.0"\n}\n',
  );
  await writeFile(
    resolve(root, 'CHANGELOG.md'),
    '# Changelog\n\n## [Unreleased]\n\n<!-- release-notes -->\n',
  );
  const fragment = {
    schemaVersion: 1,
    issue: 101,
    category: 'changed',
    summary: 'Synchronize every release version.',
    audience: 'operators',
    packages: ['@nexa/desktop', 'nexa-chat'],
    breaking: false,
    migration: null,
    ...fragmentOverrides,
  };
  await writeFile(
    resolve(root, '.changes/101-versioning.json'),
    `${JSON.stringify(fragment, null, 2)}\n`,
  );
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true })),
  );
});

describe('semantic versions', () => {
  it('validates and compares release and prerelease versions', () => {
    expect(parseSemanticVersion('2.3.4-rc.2+build.7')).toMatchObject({
      major: 2,
      minor: 3,
      patch: 4,
      prerelease: ['rc', '2'],
    });
    expect(compareSemanticVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(
      0,
    );
    expect(compareSemanticVersions('1.0.0-rc.10', '1.0.0')).toBeLessThan(0);
    expect(() => parseSemanticVersion('01.0.0')).toThrow(
      ReleaseValidationError,
    );
  });
});

describe('release state', () => {
  it('checks every manifest, lock, desktop version, pin, and bounded fragment', async () => {
    const root = await fixture();
    const result = await checkReleaseState(root);
    expect(result.version).toBe('0.1.0');
    expect(result.manifests).toHaveLength(4);
    expect(result.fragments.map((fragment) => fragment.issue)).toEqual([101]);
  });

  it('rejects drift in an internal dependency pin', async () => {
    const root = await fixture();
    const path = resolve(root, 'apps/server/package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies['@nexa/domain'] = '^0.1.0';
    await writeFile(path, JSON.stringify(manifest));
    await expect(checkReleaseState(root)).rejects.toThrow('must be pinned');
  });

  it('rejects duplicate, unbounded, and unsafe fragment metadata', async () => {
    const root = await fixture({ summary: 'x'.repeat(241) });
    await expect(checkReleaseState(root)).rejects.toThrow('invalid summary');
  });

  it('requires migration guidance only for breaking changes', async () => {
    const root = await fixture({ breaking: true });
    await expect(checkReleaseState(root)).rejects.toThrow('needs migration');
  });
});

describe('release preparation', () => {
  it('makes a deterministic dry-run plan without touching the repository', async () => {
    const root = await fixture({
      summary: 'Escape [links](https://invalid.example).',
    });
    const before = await readFile(resolve(root, 'package.json'), 'utf8');
    const first = await prepareRelease(root, '0.2.0-rc.1', '2026-07-22');
    const second = await prepareRelease(root, '0.2.0-rc.1', '2026-07-22');
    expect(summarizePlan(first)).toEqual(summarizePlan(second));
    expect(await readFile(resolve(root, 'package.json'), 'utf8')).toBe(before);
    expect(first.writes.get('CHANGELOG.md')).toContain(
      'Escape \\[links\\]\\(https://invalid\\.example\\)\\.',
    );
  });

  it('stages every replacement before applying files and consuming fragments', async () => {
    const root = await fixture();
    const plan = await prepareRelease(root, '0.2.0', '2026-07-22');
    await applyReleasePlan(root, plan);
    const checked = await checkReleaseState(root);
    expect(checked.version).toBe('0.2.0');
    expect(checked.fragments).toHaveLength(0);
    expect(await readFile(resolve(root, 'CHANGELOG.md'), 'utf8')).toContain(
      '## [0.2.0] - 2026-07-22',
    );
    expect(
      JSON.parse(
        await readFile(resolve(root, 'release/candidate-policy.json'), 'utf8'),
      ),
    ).toMatchObject({ targetVersion: '0.2.0' });
    expect(
      JSON.parse(
        await readFile(resolve(root, 'release/update-policy.json'), 'utf8'),
      ),
    ).toMatchObject({ targetVersion: '0.2.0' });
  });

  it('rejects regressions and invalid calendar dates', async () => {
    const root = await fixture();
    await expect(prepareRelease(root, '0.1.0', '2026-07-22')).rejects.toThrow(
      'newer',
    );
    await expect(prepareRelease(root, '0.2.0', '2026-02-30')).rejects.toThrow(
      'invalid release date',
    );
  });
});
