import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(repositoryRoot, 'apps/server/dist-production');

await rm(outputDirectory, { force: true, recursive: true });

await build({
  absWorkingDir: repositoryRoot,
  bundle: true,
  entryNames: '[name]',
  entryPoints: {
    main: 'apps/server/src/main.ts',
    migrate: 'apps/server/src/migrate.ts',
  },
  external: [
    '@aws-sdk/client-s3',
    'fastify',
    'pg',
    'redis',
    'web-push',
    'ws',
    'zod',
  ],
  format: 'esm',
  legalComments: 'eof',
  logLevel: 'info',
  metafile: true,
  minify: false,
  outdir: outputDirectory,
  outExtension: { '.js': '.mjs' },
  packages: 'bundle',
  platform: 'node',
  sourcemap: false,
  splitting: false,
  target: ['node24'],
  treeShaking: true,
});
