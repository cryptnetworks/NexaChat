import { gzipSync } from 'node:zlib';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  collectPerformanceEnvironment,
  comparableEnvironmentKey,
} from './environment.js';

export interface BundleMeasurements {
  javascriptBytes: number;
  javascriptGzipBytes: number;
  cssBytes: number;
  cssGzipBytes: number;
  totalAssetBytes: number;
  largestJavascriptChunkBytes: number;
  javascriptChunks: number;
  cssChunks: number;
}

export const bundleBudget = {
  maxJavascriptBytes: 307_200,
  maxJavascriptGzipBytes: 92_160,
  maxCssBytes: 8_192,
  maxTotalAssetBytes: 358_400,
  maxLargestJavascriptChunkBytes: 307_200,
  maxRegressionPercent: 10,
} as const;

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : Promise.resolve([path]);
    }),
  );
  return nested.flat().sort();
}

export function evaluateBundle(
  measurements: BundleMeasurements,
  baseline?: BundleMeasurements,
): {
  passed: boolean;
  failures: string[];
  regressions: Record<string, number>;
} {
  const failures: string[] = [];
  if (measurements.javascriptBytes > bundleBudget.maxJavascriptBytes)
    failures.push('javascript_bytes_exceeded');
  if (measurements.javascriptGzipBytes > bundleBudget.maxJavascriptGzipBytes)
    failures.push('javascript_gzip_bytes_exceeded');
  if (measurements.cssBytes > bundleBudget.maxCssBytes)
    failures.push('css_bytes_exceeded');
  if (measurements.totalAssetBytes > bundleBudget.maxTotalAssetBytes)
    failures.push('total_asset_bytes_exceeded');
  if (
    measurements.largestJavascriptChunkBytes >
    bundleBudget.maxLargestJavascriptChunkBytes
  )
    failures.push('largest_javascript_chunk_exceeded');
  const regressions: Record<string, number> = {};
  if (baseline)
    for (const key of [
      'javascriptBytes',
      'javascriptGzipBytes',
      'cssBytes',
      'totalAssetBytes',
      'largestJavascriptChunkBytes',
    ] as const) {
      const previous = baseline[key];
      const regression =
        previous === 0 ? 0 : ((measurements[key] - previous) / previous) * 100;
      regressions[key] = Number(regression.toFixed(4));
      if (regression > bundleBudget.maxRegressionPercent)
        failures.push(`${key}_regression_exceeded`);
    }
  return { passed: failures.length === 0, failures, regressions };
}

async function main(): Promise<void> {
  const directory = resolve(option('directory') ?? 'apps/web/dist');
  const outputPath = option('output') ?? process.env.NEXA_BUNDLE_RESULT_PATH;
  const baselinePath = option('baseline') ?? process.env.NEXA_BUNDLE_BASELINE;
  const assets = await files(directory);
  const measured = await Promise.all(
    assets.map(async (path) => {
      const bytes = await readFile(path);
      return {
        path: basename(path),
        extension: extname(path),
        bytes: bytes.byteLength,
        gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
      };
    }),
  );
  const javascript = measured.filter(({ extension }) => extension === '.js');
  const css = measured.filter(({ extension }) => extension === '.css');
  const measurements: BundleMeasurements = {
    javascriptBytes: javascript.reduce((sum, asset) => sum + asset.bytes, 0),
    javascriptGzipBytes: javascript.reduce(
      (sum, asset) => sum + asset.gzipBytes,
      0,
    ),
    cssBytes: css.reduce((sum, asset) => sum + asset.bytes, 0),
    cssGzipBytes: css.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    totalAssetBytes: measured.reduce((sum, asset) => sum + asset.bytes, 0),
    largestJavascriptChunkBytes: Math.max(
      0,
      ...javascript.map(({ bytes }) => bytes),
    ),
    javascriptChunks: javascript.length,
    cssChunks: css.length,
  };
  const baseline = baselinePath
    ? (JSON.parse(await readFile(baselinePath, 'utf8')) as {
        schemaVersion: number;
        environmentKey: string;
        measurements: BundleMeasurements;
      })
    : undefined;
  const environment = await collectPerformanceEnvironment('production');
  const environmentKey = comparableEnvironmentKey(environment);
  if (baseline && baseline.schemaVersion !== 1)
    throw new Error('bundle baseline schema is not supported');
  const evaluation = evaluateBundle(measurements, baseline?.measurements);
  const report = {
    schemaVersion: 1,
    environmentKey,
    environment,
    directory: 'apps/web/dist',
    budget: bundleBudget,
    measurements,
    assets: measured,
    evaluation,
    passed: evaluation.passed,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(serialized);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('bundle-budget.ts')) await main();
