import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, freemem, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { InMemoryCommunityService, type CommunityService } from '@nexa/domain';
import { buildApp } from '../../apps/server/src/app.js';
import { initializeDatabase } from '../../apps/server/src/database.js';
import type { FastifyInstance } from 'fastify';
import { performanceProfile, type ApiWorkloadPolicy } from './api-budgets.js';
import {
  aggregateTrials,
  evaluateBudget,
  summarizeDistribution,
  type AggregateSummary,
  type TrialSummary,
} from './statistics.js';

interface WorkloadRuntime {
  policy: ApiWorkloadPolicy;
  execute: () => Promise<void>;
}

interface BenchmarkReport {
  schemaVersion: 1;
  profile: string;
  environmentKey: string;
  environment: Record<string, string | number>;
  policy: {
    percentiles: readonly ['p95', 'p99'];
    warmupDiscarded: true;
    baselineEnvironmentMustMatch: true;
  };
  startedAt: string;
  completedAt: string;
  workloads: Record<
    string,
    {
      description: string;
      dataset: string;
      warmupSamples: number;
      measuredSamples: number;
      trials: number;
      concurrency: number;
      budget: ApiWorkloadPolicy['budget'];
      result: AggregateSummary;
      evaluation: ReturnType<typeof evaluateBudget>;
    }
  >;
  passed: boolean;
}

interface BaselineReport {
  schemaVersion: number;
  profile: string;
  environmentKey: string;
  workloads: Record<string, { result: AggregateSummary }>;
}

interface RuntimeResources {
  workloads: WorkloadRuntime[];
  environment?: Record<string, string | number>;
  close(): Promise<void>;
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

async function executeBatch(
  count: number,
  concurrency: number,
  execute: () => Promise<void>,
  measured: boolean,
): Promise<number[]> {
  const durations = Array<number>(count);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, count) }, async () => {
      for (let index = next++; index < count; index = next++) {
        const started = performance.now();
        await execute();
        if (measured) durations[index] = performance.now() - started;
      }
    }),
  );
  return measured ? durations : [];
}

async function runWorkload(
  runtime: WorkloadRuntime,
): Promise<AggregateSummary> {
  const { policy, execute } = runtime;
  await executeBatch(policy.warmupSamples, policy.concurrency, execute, false);
  const trials: TrialSummary[] = [];
  for (let trial = 0; trial < policy.trials; trial += 1) {
    const started = performance.now();
    const samples = await executeBatch(
      policy.measuredSamples,
      policy.concurrency,
      execute,
      true,
    );
    const elapsedMs = performance.now() - started;
    trials.push({
      latency: summarizeDistribution(samples),
      elapsedMs,
      throughputPerSecond: policy.measuredSamples / (elapsedMs / 1_000),
    });
  }
  const result = aggregateTrials(trials);
  return {
    ...result,
    medianP95Ms: round(result.medianP95Ms),
    medianP99Ms: round(result.medianP99Ms),
    medianThroughputPerSecond: round(result.medianThroughputPerSecond),
    p95CoefficientOfVariation: round(result.p95CoefficientOfVariation),
    trials: result.trials.map((trial) => ({
      elapsedMs: round(trial.elapsedMs),
      throughputPerSecond: round(trial.throughputPerSecond),
      latency: {
        count: trial.latency.count,
        minMs: round(trial.latency.minMs),
        maxMs: round(trial.latency.maxMs),
        meanMs: round(trial.latency.meanMs),
        p50Ms: round(trial.latency.p50Ms),
        p95Ms: round(trial.latency.p95Ms),
        p99Ms: round(trial.latency.p99Ms),
        standardDeviationMs: round(trial.latency.standardDeviationMs),
      },
    })),
  };
}

async function seed(
  service: CommunityService,
  messageCount: number,
): Promise<{ actorId: string; spaceId: string }> {
  const account = await service.createAccount('Performance actor');
  const community = await service.createCommunity(
    account.id,
    'Performance community',
  );
  const space = await service.createTextSpace(
    community.id,
    account.id,
    'performance',
  );
  for (let index = 0; index < messageCount; index += 1)
    await service.postMessage(
      space.id,
      account.id,
      `bounded performance message ${String(index).padStart(6, '0')}`,
      `performance-${String(index).padStart(6, '0')}`,
    );
  return { actorId: account.id, spaceId: space.id };
}

async function ciRuntime(
  policies: readonly ApiWorkloadPolicy[],
): Promise<RuntimeResources> {
  const service = new InMemoryCommunityService();
  const dataset = await seed(service, 1_000);
  const app = buildApp(
    service,
    undefined,
    undefined,
    undefined,
    benchmarkServerConfig,
    undefined,
    undefined,
    undefined,
    { logging: false },
  );
  await app.ready();
  const executions: Record<string, () => Promise<void>> = {
    'http.health.live': async () => {
      const response = await app.inject('/health/live');
      if (response.statusCode !== 200)
        throw new Error('health workload failed');
    },
    'http.messages.page': async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/spaces/${dataset.spaceId}/messages?actorId=${dataset.actorId}&limit=100`,
      });
      if (response.statusCode !== 200)
        throw new Error('message-page workload failed');
    },
  };
  return {
    workloads: bindWorkloads(policies, executions),
    close: () => app.close(),
  };
}

function safeDatabaseName(name: string): string {
  if (!/^nexa_perf_[a-f0-9]{32}$/.test(name))
    throw new Error('refusing unsafe performance database name');
  return name;
}

const benchmarkServerConfig = {
  host: '127.0.0.1',
  port: 0,
  bodyLimitBytes: 16_384,
  requestTimeoutMs: 15_000,
  shutdownTimeoutMs: 5_000,
  rateLimit: 1_000_000,
  rateWindowMs: 60_000,
  logLevel: 'error',
  trustedProxyCidrs: [] as string[],
} as const;

async function postgresRuntime(
  policies: readonly ApiWorkloadPolicy[],
): Promise<RuntimeResources> {
  const adminConnection = process.env.NEXA_PERF_DATABASE_URL;
  if (!adminConnection)
    throw new Error(
      'NEXA_PERF_DATABASE_URL is required for the postgres profile',
    );
  const adminUrl = new URL(adminConnection);
  if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol))
    throw new Error('NEXA_PERF_DATABASE_URL must use PostgreSQL');
  const databaseName = safeDatabaseName(
    `nexa_perf_${randomUUID().replaceAll('-', '')}`,
  );
  const benchmarkUrl = new URL(adminUrl);
  benchmarkUrl.pathname = `/${databaseName}`;
  const admin = new Pool({
    connectionString: adminUrl.toString(),
    connectionTimeoutMillis: 2_000,
  });
  let app: FastifyInstance | undefined;
  let database: Awaited<ReturnType<typeof initializeDatabase>> | undefined;
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    database = await initializeDatabase({
      connectionString: benchmarkUrl.toString(),
      maxConnections: 24,
      connectionTimeoutMs: 2_000,
      idleTimeoutMs: 5_000,
      queryTimeoutMs: 5_000,
      migrationsDirectory: resolve('apps/server/migrations'),
    });
    const dataset = await seed(database.service, 2_500);
    app = buildApp(
      database.service,
      database.readiness,
      undefined,
      database.authorization,
      benchmarkServerConfig,
      undefined,
      undefined,
      database.experience,
      { logging: false },
    );
    await app.ready();
    const runtimeApp = app;
    const runtimeDatabase = database;
    const version = await database.pool.query<{ server_version: string }>(
      'SHOW server_version',
    );
    const executions: Record<string, () => Promise<void>> = {
      'postgres.messages.page.http': async () => {
        const response = await runtimeApp.inject({
          method: 'GET',
          url: `/v1/spaces/${dataset.spaceId}/messages?actorId=${dataset.actorId}&limit=100`,
        });
        if (response.statusCode !== 200)
          throw new Error('PostgreSQL HTTP workload failed');
      },
      'postgres.messages.page.query': async () => {
        const result = await runtimeDatabase.pool.query(
          `SELECT id, created_at FROM messages
           WHERE space_id=$1 ORDER BY created_at,id LIMIT 100`,
          [dataset.spaceId],
        );
        if (result.rowCount !== 100)
          throw new Error('PostgreSQL query workload failed');
      },
    };
    return {
      workloads: bindWorkloads(policies, executions),
      environment: {
        postgresVersion: version.rows[0]?.server_version ?? 'unknown',
        postgresPoolMaximum: 24,
      },
      close: async () => {
        await app?.close();
        await database?.pool.end();
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        await admin.end();
      },
    };
  } catch (error) {
    await app?.close();
    await database?.pool.end();
    if (created)
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
    throw error;
  }
}

function bindWorkloads(
  policies: readonly ApiWorkloadPolicy[],
  executions: Record<string, () => Promise<void>>,
): WorkloadRuntime[] {
  return policies.map((policy) => {
    const execute = executions[policy.id];
    if (!execute) throw new Error(`workload ${policy.id} is not implemented`);
    return { policy, execute };
  });
}

async function loadBaseline(
  path: string | undefined,
): Promise<BaselineReport | undefined> {
  if (!path) return undefined;
  return JSON.parse(await readFile(path, 'utf8')) as BaselineReport;
}

async function main(): Promise<void> {
  const profile = performanceProfile(option('profile') ?? 'ci');
  const outputPath = option('output') ?? process.env.NEXA_PERF_RESULT_PATH;
  const baseline = await loadBaseline(
    option('baseline') ?? process.env.NEXA_PERF_BASELINE,
  );
  const cpu = cpus()[0];
  const environmentKey = [
    platform(),
    arch(),
    release(),
    process.version,
    String(cpus().length),
    cpu?.model ?? 'unknown',
    profile.id,
  ].join('|');
  if (
    baseline &&
    (baseline.schemaVersion !== 1 ||
      baseline.profile !== profile.id ||
      baseline.environmentKey !== environmentKey)
  )
    throw new Error(
      'baseline is not comparable with this environment and profile',
    );

  const startedAt = new Date().toISOString();
  const runtime =
    profile.id === 'postgres'
      ? await postgresRuntime(profile.workloads)
      : await ciRuntime(profile.workloads);
  const workloads: BenchmarkReport['workloads'] = {};
  try {
    for (const workload of runtime.workloads) {
      const result = await runWorkload(workload);
      workloads[workload.policy.id] = {
        description: workload.policy.description,
        dataset: workload.policy.dataset,
        warmupSamples: workload.policy.warmupSamples,
        measuredSamples: workload.policy.measuredSamples,
        trials: workload.policy.trials,
        concurrency: workload.policy.concurrency,
        budget: workload.policy.budget,
        result,
        evaluation: evaluateBudget(
          result,
          workload.policy.budget,
          baseline?.workloads[workload.policy.id]?.result,
        ),
      };
    }
  } finally {
    await runtime.close();
  }
  const report: BenchmarkReport = {
    schemaVersion: 1,
    profile: profile.id,
    environmentKey,
    environment: {
      policyEnvironment: profile.environment,
      platform: platform(),
      architecture: arch(),
      operatingSystemRelease: release(),
      nodeVersion: process.version,
      cpuModel: cpu?.model ?? 'unknown',
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtCompletion: freemem(),
      ...runtime.environment,
    },
    policy: {
      percentiles: ['p95', 'p99'],
      warmupDiscarded: true,
      baselineEnvironmentMustMatch: true,
    },
    startedAt,
    completedAt: new Date().toISOString(),
    workloads,
    passed: Object.values(workloads).every(
      (workload) => workload.evaluation.passed,
    ),
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(serialized);
  if (!report.passed) process.exitCode = 1;
}

await main();
