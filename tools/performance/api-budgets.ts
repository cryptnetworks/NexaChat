import type { PerformanceBudget } from './statistics.js';

export interface ApiWorkloadPolicy {
  id: string;
  description: string;
  dataset: string;
  warmupSamples: number;
  measuredSamples: number;
  trials: number;
  concurrency: number;
  budget: PerformanceBudget;
}

export interface ApiProfilePolicy {
  id: 'ci' | 'postgres';
  environment: string;
  workloads: ApiWorkloadPolicy[];
}

const sharedPolicy = {
  maxP95CoefficientOfVariation: 0.75,
  maxRegressionPercent: 15,
} as const;

export const API_PERFORMANCE_PROFILES: readonly ApiProfilePolicy[] = [
  {
    id: 'ci',
    environment:
      'single Node.js process using Fastify injection and bounded in-memory persistence',
    workloads: [
      {
        id: 'http.health.live',
        description:
          'Unauthenticated liveness request and response serialization',
        dataset: 'No durable records; one Fastify process',
        warmupSamples: 100,
        measuredSamples: 500,
        trials: 7,
        concurrency: 16,
        budget: {
          ...sharedPolicy,
          maxMedianP95Ms: 25,
          maxMedianP99Ms: 50,
        },
      },
      {
        id: 'http.messages.page',
        description:
          'Authorized first-page message history request with schema serialization',
        dataset:
          'One owner, community, text space, and 1,000 deterministic bounded messages',
        warmupSamples: 50,
        measuredSamples: 300,
        trials: 7,
        concurrency: 8,
        budget: {
          ...sharedPolicy,
          maxMedianP95Ms: 75,
          maxMedianP99Ms: 125,
        },
      },
    ],
  },
  {
    id: 'postgres',
    environment:
      'single Node.js API process and a disposable PostgreSQL database on the benchmark host',
    workloads: [
      {
        id: 'postgres.messages.page.http',
        description:
          'Authorized HTTP message pagination including PostgreSQL authorization and serialization',
        dataset:
          'One owner, community, text space, and 2,500 deterministic bounded messages',
        warmupSamples: 50,
        measuredSamples: 250,
        trials: 7,
        concurrency: 16,
        budget: {
          ...sharedPolicy,
          maxMedianP95Ms: 250,
          maxMedianP99Ms: 500,
        },
      },
      {
        id: 'postgres.messages.page.query',
        description:
          'Parameterized indexed PostgreSQL message-page query without network serialization',
        dataset:
          'The same 2,500-message disposable dataset used by the HTTP workload',
        warmupSamples: 50,
        measuredSamples: 250,
        trials: 7,
        concurrency: 16,
        budget: {
          ...sharedPolicy,
          maxMedianP95Ms: 100,
          maxMedianP99Ms: 200,
        },
      },
    ],
  },
];

export function performanceProfile(id: string): ApiProfilePolicy {
  const profile = API_PERFORMANCE_PROFILES.find((value) => value.id === id);
  if (!profile) throw new Error('profile must be ci or postgres');
  for (const workload of profile.workloads) {
    if (workload.trials < 5)
      throw new Error(`${workload.id} must use at least five trials`);
    if (workload.warmupSamples < 20)
      throw new Error(`${workload.id} warmup is too small`);
    if (workload.measuredSamples < 100)
      throw new Error(`${workload.id} measured sample is too small`);
    if (workload.concurrency < 1)
      throw new Error(`${workload.id} concurrency must be positive`);
  }
  return profile;
}
