import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Agent, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
} from 'node:perf_hooks';
import { InMemoryCommunityService } from '@nexa/domain';
import { buildApp } from '../../apps/server/src/app.js';
import {
  collectPerformanceEnvironment,
  comparableEnvironmentKey,
} from './environment.js';
import { serverEndurancePolicy } from './server-policy.js';
import { roundDistribution, summarizeDistribution } from './statistics.js';

interface ComparableReport {
  schemaVersion: number;
  profile: string;
  environmentKey: string;
  measurements: {
    latency: { p95Ms: number };
    requestsPerSecond: number;
    memory: { peakRssBytes: number };
  };
}

interface MemorySample {
  elapsedMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBufferBytes: number;
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

function percentIncrease(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : Number.POSITIVE_INFINITY;
  return ((current - previous) / previous) * 100;
}

function percentDecrease(current: number, previous: number): number {
  return -percentIncrease(current, previous);
}

function slopePerMinute(
  samples: readonly MemorySample[],
  select: (sample: MemorySample) => number,
): number {
  if (samples.length < 2) return 0;
  const meanX =
    samples.reduce((sum, sample) => sum + sample.elapsedMs, 0) / samples.length;
  const meanY =
    samples.reduce((sum, sample) => sum + select(sample), 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    const x = sample.elapsedMs - meanX;
    numerator += x * (select(sample) - meanY);
    denominator += x * x;
  }
  return denominator === 0 ? 0 : (numerator / denominator) * 60_000;
}

function resourceInventory(
  resources: readonly string[],
): Record<string, number> {
  const inventory: Record<string, number> = {};
  for (const resource of resources)
    inventory[resource] = (inventory[resource] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(inventory).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

async function executeBatch(
  count: number,
  concurrency: number,
  execute: (index: number) => Promise<boolean>,
): Promise<number> {
  let next = 0;
  let failures = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      for (let index = next++; index < count; index = next++)
        if (!(await execute(index))) failures += 1;
    }),
  );
  return failures;
}

function request(
  agent: Agent,
  endpoint: string,
  path: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const outgoing = httpRequest(
      new URL(path, endpoint),
      { agent, method: 'GET', timeout: 15_000 },
      (response) => {
        response.resume();
        response.once('end', () => {
          resolve(response.statusCode === 200);
        });
        response.once('error', () => {
          resolve(false);
        });
      },
    );
    outgoing.once('timeout', () => {
      outgoing.destroy();
    });
    outgoing.once('error', () => {
      resolve(false);
    });
    outgoing.end();
  });
}

async function main(): Promise<void> {
  const policy = serverEndurancePolicy(option('profile') ?? 'ci');
  const outputPath = option('output') ?? process.env.NEXA_SERVER_RESULT_PATH;
  const baselinePath = option('baseline') ?? process.env.NEXA_SERVER_BASELINE;
  const environment = await collectPerformanceEnvironment('production');
  const environmentKey = comparableEnvironmentKey(environment);
  const baseline = baselinePath
    ? (JSON.parse(await readFile(baselinePath, 'utf8')) as ComparableReport)
    : undefined;
  if (baseline) {
    const comparable =
      baseline.schemaVersion === 1 &&
      baseline.profile === policy.id &&
      baseline.environmentKey === environmentKey &&
      Number.isFinite(baseline.measurements.latency.p95Ms) &&
      Number.isFinite(baseline.measurements.requestsPerSecond) &&
      Number.isFinite(baseline.measurements.memory.peakRssBytes);
    if (!comparable)
      throw new Error(
        'baseline is not comparable with this environment and profile',
      );
  }

  const service = new InMemoryCommunityService();
  const account = await service.createAccount('Endurance actor');
  const community = await service.createCommunity(
    account.id,
    'Endurance community',
  );
  const space = await service.createTextSpace(
    community.id,
    account.id,
    'endurance',
  );
  for (let index = 0; index < policy.messageCount; index += 1)
    await service.postMessage(
      space.id,
      account.id,
      `bounded endurance message ${String(index).padStart(6, '0')}`,
      `endurance-${String(index).padStart(6, '0')}`,
    );

  const readyStarted = performance.now();
  const app = buildApp(
    service,
    undefined,
    undefined,
    undefined,
    {
      host: '127.0.0.1',
      port: 0,
      bodyLimitBytes: 16_384,
      requestTimeoutMs: 15_000,
      shutdownTimeoutMs: 5_000,
      rateLimit: 1_000_000,
      rateWindowMs: 60_000,
      logLevel: 'error',
      trustedProxyCidrs: [] as string[],
    },
    undefined,
    undefined,
    undefined,
    { logging: false },
  );
  await app.ready();
  const readyMs = performance.now() - readyStarted;
  const listenStarted = performance.now();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const listenMs = performance.now() - listenStarted;
  const address = app.server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${String(address.port)}`;
  const agent = new Agent({
    keepAlive: true,
    maxSockets: policy.concurrentRequests,
    maxFreeSockets: policy.concurrentRequests,
  });

  const execute = (index: number): Promise<boolean> =>
    request(
      agent,
      endpoint,
      index % 4 === 0
        ? '/health/live'
        : `/v1/spaces/${space.id}/messages?actorId=${account.id}&limit=100`,
    );
  await executeBatch(policy.warmupRequests, policy.concurrentRequests, execute);

  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  const gcDurations: number[] = [];
  const gcObserver = new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries())
      if (gcDurations.length < 100_000) gcDurations.push(entry.duration);
  });
  gcObserver.observe({ entryTypes: ['gc'] });
  eventLoop.enable();

  const memoryBefore = process.memoryUsage();
  const activeResourcesBefore = process.getActiveResourcesInfo();
  let peakRssBytes = memoryBefore.rss;
  let peakHeapUsedBytes = memoryBefore.heapUsed;
  const memorySamples: MemorySample[] = [];
  let nextMemorySampleMs = 0;
  const recordMemory = (elapsedMs: number, current = process.memoryUsage()) => {
    peakRssBytes = Math.max(peakRssBytes, current.rss);
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, current.heapUsed);
    if (elapsedMs < nextMemorySampleMs) return;
    memorySamples.push({
      elapsedMs: round(elapsedMs),
      rssBytes: current.rss,
      heapUsedBytes: current.heapUsed,
      externalBytes: current.external,
      arrayBufferBytes: current.arrayBuffers,
    });
    nextMemorySampleMs += policy.memorySampleIntervalMs;
  };
  recordMemory(0, memoryBefore);
  const memoryTimelineStarted = performance.now();
  const memoryTimer = setInterval(() => {
    recordMemory(performance.now() - memoryTimelineStarted);
  }, 50);
  memoryTimer.unref();

  const latencies: number[] = [];
  let requests = 0;
  let errors = 0;
  let next = 0;
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const deadline = started + policy.durationSeconds * 1_000;
  await Promise.all(
    Array.from({ length: policy.concurrentRequests }, async () => {
      while (performance.now() < deadline) {
        const index = next++;
        const requestStarted = performance.now();
        if (!(await execute(index))) errors += 1;
        const duration = performance.now() - requestStarted;
        if (latencies.length < policy.maximumLatencySamples)
          latencies.push(duration);
        requests += 1;
      }
    }),
  );
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfterLoad = process.memoryUsage();
  recordMemory(elapsedMs, memoryAfterLoad);
  clearInterval(memoryTimer);
  eventLoop.disable();
  gcObserver.disconnect();
  agent.destroy();
  const shutdownStarted = performance.now();
  await app.close();
  const shutdownMs = performance.now() - shutdownStarted;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const memoryAfterRecovery = process.memoryUsage();
  const activeResourcesAfter = process.getActiveResourcesInfo();

  const latency = summarizeDistribution(latencies);
  const gc = summarizeDistribution(gcDurations.length > 0 ? gcDurations : [0]);
  const eventLoopP99Ms = eventLoop.percentile(99) / 1_000_000;
  const eventLoopMaximumMs = eventLoop.max / 1_000_000;
  const requestsPerSecond = requests / (elapsedMs / 1_000);
  const errorRate = requests === 0 ? 1 : errors / requests;
  const rssGrowthBytes = Math.max(
    0,
    memoryAfterRecovery.rss - memoryBefore.rss,
  );
  const heapUsedGrowthBytes = Math.max(
    0,
    memoryAfterRecovery.heapUsed - memoryBefore.heapUsed,
  );
  const externalGrowthBytes = Math.max(
    0,
    memoryAfterRecovery.external - memoryBefore.external,
  );
  const finalWindowStartMs = elapsedMs * 0.8;
  const finalWindowSamples = memorySamples.filter(
    (sample) => sample.elapsedMs >= finalWindowStartMs,
  );
  const slopeWindowStartMs = elapsedMs * 0.2;
  const slopeWindowSamples = memorySamples.filter(
    (sample) => sample.elapsedMs >= slopeWindowStartMs,
  );
  const canEstimateSlope =
    policy.durationSeconds >= 60 && slopeWindowSamples.length >= 5;
  const minimumFinalHeapUsedBytes = Math.min(
    memoryAfterRecovery.heapUsed,
    ...finalWindowSamples.map((sample) => sample.heapUsedBytes),
  );
  const minimumFinalHeapGrowthBytes = Math.max(
    0,
    minimumFinalHeapUsedBytes - memoryBefore.heapUsed,
  );
  const activeResourceGrowth =
    activeResourcesAfter.length - activeResourcesBefore.length;
  const failures: string[] = [];
  if (readyMs > policy.budget.maxReadyMs) failures.push('ready_time_exceeded');
  if (listenMs > policy.budget.maxListenMs)
    failures.push('listen_time_exceeded');
  if (shutdownMs > policy.budget.maxShutdownMs)
    failures.push('shutdown_time_exceeded');
  if (latency.p95Ms > policy.budget.maxP95Ms) failures.push('p95_exceeded');
  if (latency.p99Ms > policy.budget.maxP99Ms) failures.push('p99_exceeded');
  if (eventLoopP99Ms > policy.budget.maxEventLoopP99Ms)
    failures.push('event_loop_p99_exceeded');
  if (eventLoopMaximumMs > policy.budget.maxEventLoopDelayMs)
    failures.push('event_loop_max_exceeded');
  if (gc.p99Ms > policy.budget.maxGcP99Ms) failures.push('gc_p99_exceeded');
  if (errorRate > policy.budget.maxErrorRate)
    failures.push('error_rate_exceeded');
  if (requestsPerSecond < policy.budget.minRequestsPerSecond)
    failures.push('throughput_below_minimum');
  if (peakRssBytes > policy.budget.maxPeakRssBytes)
    failures.push('rss_exceeded');
  if (rssGrowthBytes > policy.budget.maxRssGrowthBytes)
    failures.push('rss_growth_exceeded');
  if (
    minimumFinalHeapGrowthBytes > policy.budget.maxMinimumFinalHeapGrowthBytes
  )
    failures.push('minimum_final_heap_growth_exceeded');
  if (externalGrowthBytes > policy.budget.maxExternalGrowthBytes)
    failures.push('external_growth_exceeded');
  if (activeResourceGrowth > policy.budget.maxActiveResourceGrowth)
    failures.push('active_resource_growth_exceeded');

  const baselineRegression = baseline
    ? {
        p95Percent: percentIncrease(
          latency.p95Ms,
          baseline.measurements.latency.p95Ms,
        ),
        throughputDecreasePercent: percentDecrease(
          requestsPerSecond,
          baseline.measurements.requestsPerSecond,
        ),
        peakRssPercent: percentIncrease(
          peakRssBytes,
          baseline.measurements.memory.peakRssBytes,
        ),
      }
    : null;
  if (
    baselineRegression &&
    baselineRegression.p95Percent > policy.budget.maxP95RegressionPercent
  )
    failures.push('p95_regression_exceeded');
  if (
    baselineRegression &&
    baselineRegression.throughputDecreasePercent >
      policy.budget.maxThroughputRegressionPercent
  )
    failures.push('throughput_regression_exceeded');
  if (
    baselineRegression &&
    baselineRegression.peakRssPercent >
      policy.budget.maxPeakRssRegressionPercent
  )
    failures.push('peak_rss_regression_exceeded');

  const report = {
    schemaVersion: 1,
    profile: policy.id,
    environmentKey,
    environment,
    workload: {
      dataset: `${String(policy.messageCount)} messages in one authorized text space`,
      durationSeconds: policy.durationSeconds,
      warmupRequests: policy.warmupRequests,
      concurrentRequests: policy.concurrentRequests,
      maximumLatencySamples: policy.maximumLatencySamples,
      memorySampleIntervalMs: policy.memorySampleIntervalMs,
      requestMix: { health: 0.25, messagePage: 0.75 },
    },
    budget: policy.budget,
    measurements: {
      lifecycle: {
        readyMs: round(readyMs),
        listenMs: round(listenMs),
        shutdownMs: round(shutdownMs),
      },
      requests,
      errors,
      errorRate: round(errorRate),
      elapsedMs: round(elapsedMs),
      requestsPerSecond: round(requestsPerSecond),
      latency: roundDistribution(latency),
      eventLoop: {
        p50Ms: round(eventLoop.percentile(50) / 1_000_000),
        p75Ms: round(eventLoop.percentile(75) / 1_000_000),
        p90Ms: round(eventLoop.percentile(90) / 1_000_000),
        p95Ms: round(eventLoop.percentile(95) / 1_000_000),
        p99Ms: round(eventLoopP99Ms),
        maxMs: round(eventLoopMaximumMs),
      },
      garbageCollection: {
        count: gcDurations.length,
        p50Ms: round(gc.p50Ms),
        p95Ms: round(gc.p95Ms),
        p99Ms: round(gc.p99Ms),
        maxMs: round(gc.maxMs),
      },
      cpu: {
        userMicroseconds: cpu.user,
        systemMicroseconds: cpu.system,
        singleCorePercent: round(
          ((cpu.user + cpu.system) / 1_000 / elapsedMs) * 100,
        ),
      },
      memory: {
        before: memoryBefore,
        afterLoad: memoryAfterLoad,
        afterRecovery: memoryAfterRecovery,
        peakRssBytes,
        peakHeapUsedBytes,
        rssGrowthBytes,
        heapUsedGrowthBytes,
        minimumFinalHeapUsedBytes,
        minimumFinalHeapGrowthBytes,
        finalWindowStartMs: round(finalWindowStartMs),
        externalGrowthBytes,
        rssSlopeBytesPerMinute: canEstimateSlope
          ? round(
              slopePerMinute(slopeWindowSamples, (sample) => sample.rssBytes),
            )
          : null,
        heapUsedSlopeBytesPerMinute: canEstimateSlope
          ? round(
              slopePerMinute(
                slopeWindowSamples,
                (sample) => sample.heapUsedBytes,
              ),
            )
          : null,
        slopeWindowStartMs: round(slopeWindowStartMs),
        timeline: memorySamples,
      },
      activeResources: {
        before: resourceInventory(activeResourcesBefore),
        afterRecovery: resourceInventory(activeResourcesAfter),
        totalBefore: activeResourcesBefore.length,
        totalAfterRecovery: activeResourcesAfter.length,
        growth: activeResourceGrowth,
      },
      baselineRegression:
        baselineRegression === null
          ? null
          : {
              p95Percent: round(baselineRegression.p95Percent),
              throughputDecreasePercent: round(
                baselineRegression.throughputDecreasePercent,
              ),
              peakRssPercent: round(baselineRegression.peakRssPercent),
            },
    },
    startedAt: new Date(Date.now() - elapsedMs).toISOString(),
    completedAt: new Date().toISOString(),
    failures,
    passed: failures.length === 0,
    runId: randomUUID(),
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
