export interface ServerEndurancePolicy {
  id: 'ci' | 'release' | 'soak';
  environment: string;
  durationSeconds: number;
  warmupRequests: number;
  concurrentRequests: number;
  messageCount: number;
  maximumLatencySamples: number;
  memorySampleIntervalMs: number;
  budget: {
    maxReadyMs: number;
    maxListenMs: number;
    maxShutdownMs: number;
    maxP95Ms: number;
    maxP99Ms: number;
    maxEventLoopP99Ms: number;
    maxEventLoopDelayMs: number;
    maxGcP99Ms: number;
    maxErrorRate: number;
    minRequestsPerSecond: number;
    maxPeakRssBytes: number;
    maxRssGrowthBytes: number;
    maxMinimumFinalHeapGrowthBytes: number;
    maxExternalGrowthBytes: number;
    maxActiveResourceGrowth: number;
    maxP95RegressionPercent: number;
    maxThroughputRegressionPercent: number;
    maxPeakRssRegressionPercent: number;
  };
}

const profiles: readonly ServerEndurancePolicy[] = [
  {
    id: 'ci',
    environment:
      'single production-configured Fastify process with bounded in-memory persistence',
    durationSeconds: 5,
    warmupRequests: 100,
    concurrentRequests: 8,
    messageCount: 1_000,
    maximumLatencySamples: 100_000,
    memorySampleIntervalMs: 500,
    budget: {
      maxReadyMs: 2_000,
      maxListenMs: 2_000,
      maxShutdownMs: 5_000,
      maxP95Ms: 75,
      maxP99Ms: 125,
      maxEventLoopP99Ms: 50,
      maxEventLoopDelayMs: 100,
      maxGcP99Ms: 50,
      maxErrorRate: 0,
      minRequestsPerSecond: 500,
      maxPeakRssBytes: 536_870_912,
      maxRssGrowthBytes: 201_326_592,
      maxMinimumFinalHeapGrowthBytes: 134_217_728,
      maxExternalGrowthBytes: 16_777_216,
      maxActiveResourceGrowth: 4,
      maxP95RegressionPercent: 15,
      maxThroughputRegressionPercent: 15,
      maxPeakRssRegressionPercent: 20,
    },
  },
  {
    id: 'release',
    environment:
      'single production-configured Fastify process on an otherwise idle release runner',
    durationSeconds: 60,
    warmupRequests: 250,
    concurrentRequests: 32,
    messageCount: 2_500,
    maximumLatencySamples: 250_000,
    memorySampleIntervalMs: 1_000,
    budget: {
      maxReadyMs: 2_000,
      maxListenMs: 2_000,
      maxShutdownMs: 5_000,
      maxP95Ms: 100,
      maxP99Ms: 200,
      maxEventLoopP99Ms: 50,
      maxEventLoopDelayMs: 100,
      maxGcP99Ms: 50,
      maxErrorRate: 0,
      minRequestsPerSecond: 750,
      maxPeakRssBytes: 805_306_368,
      maxRssGrowthBytes: 335_544_320,
      maxMinimumFinalHeapGrowthBytes: 67_108_864,
      maxExternalGrowthBytes: 33_554_432,
      maxActiveResourceGrowth: 4,
      maxP95RegressionPercent: 15,
      maxThroughputRegressionPercent: 15,
      maxPeakRssRegressionPercent: 20,
    },
  },
  {
    id: 'soak',
    environment:
      'single production-configured Fastify process on a dedicated endurance runner',
    durationSeconds: 900,
    warmupRequests: 500,
    concurrentRequests: 64,
    messageCount: 5_000,
    maximumLatencySamples: 500_000,
    memorySampleIntervalMs: 5_000,
    budget: {
      maxReadyMs: 2_000,
      maxListenMs: 2_000,
      maxShutdownMs: 5_000,
      maxP95Ms: 125,
      maxP99Ms: 250,
      maxEventLoopP99Ms: 50,
      maxEventLoopDelayMs: 100,
      maxGcP99Ms: 50,
      maxErrorRate: 0,
      minRequestsPerSecond: 750,
      maxPeakRssBytes: 1_073_741_824,
      maxRssGrowthBytes: 536_870_912,
      maxMinimumFinalHeapGrowthBytes: 134_217_728,
      maxExternalGrowthBytes: 67_108_864,
      maxActiveResourceGrowth: 4,
      maxP95RegressionPercent: 15,
      maxThroughputRegressionPercent: 15,
      maxPeakRssRegressionPercent: 20,
    },
  },
];

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${name} is outside safe bounds`);
  return parsed;
}

export function serverEndurancePolicy(
  id: string,
  environment: NodeJS.ProcessEnv = process.env,
): ServerEndurancePolicy {
  const selected = profiles.find((profile) => profile.id === id);
  if (!selected) throw new Error('server profile must be ci, release, or soak');
  const minimumDuration = selected.id === 'soak' ? 600 : 1;
  return {
    ...selected,
    durationSeconds: boundedInteger(
      environment.NEXA_SERVER_DURATION_SECONDS,
      selected.durationSeconds,
      minimumDuration,
      3_600,
      'duration',
    ),
    concurrentRequests: boundedInteger(
      environment.NEXA_SERVER_CONCURRENCY,
      selected.concurrentRequests,
      1,
      256,
      'concurrency',
    ),
    messageCount: boundedInteger(
      environment.NEXA_SERVER_MESSAGES,
      selected.messageCount,
      100,
      20_000,
      'message count',
    ),
  };
}

export function checkedInServerProfiles(): readonly ServerEndurancePolicy[] {
  return profiles;
}
