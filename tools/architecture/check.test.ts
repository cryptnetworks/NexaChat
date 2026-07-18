import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkArchitecture } from './check.js';

describe('architecture boundary checker', () => {
  it('accepts the repository dependency graph', async () => {
    await expect(checkArchitecture(resolve('.'))).resolves.toEqual([]);
  });

  it.each([
    [
      'forbidden-direction',
      '@nexa/domain: dependency on @nexa/postgres is not allowed',
    ],
    [
      'cycle',
      'workspace dependency cycle: @nexa/domain -> @nexa/postgres -> @nexa/domain',
    ],
    [
      'deep-import',
      'deep workspace import @nexa/domain/src/index.ts bypasses the public package entry point',
    ],
    ['undeclared-import', '@nexa/authorization is imported but not declared'],
    ['invalid-exception', 'exception 0: owner must be a non-empty string'],
  ])('rejects the %s fixture', async (fixture, expected) => {
    const root = await materializeFixture(fixture);
    expect(await checkArchitecture(root)).toContainEqual(
      expect.stringContaining(expected),
    );
  });
});

async function materializeFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), 'nexa-architecture-'));
  await cp(resolve('tools/architecture/fixtures/base'), root, {
    recursive: true,
  });
  const mutation = JSON.parse(
    await readFile(resolve(`tools/architecture/fixtures/${name}.json`), 'utf8'),
  ) as { path: string; value: unknown };
  await writeFile(
    join(root, mutation.path),
    JSON.stringify(mutation.value, null, 2),
  );
  return root;
}
