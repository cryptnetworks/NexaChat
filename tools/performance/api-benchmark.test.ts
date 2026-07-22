import { describe, expect, it } from 'vitest';
import { API_PERFORMANCE_PROFILES, performanceProfile } from './api-budgets.js';
import {
  aggregateTrials,
  evaluateBudget,
  percentile,
  summarizeDistribution,
  type TrialSummary,
} from './statistics.js';

function trial(p95Input: number): TrialSummary {
  const samples = [1, 2, 3, p95Input, p95Input];
  return {
    latency: summarizeDistribution(samples),
    elapsedMs: 10,
    throughputPerSecond: 500,
  };
}

describe('API performance policy', () => {
  it('uses interpolated percentiles and a population variance', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8);
    expect(summarizeDistribution([1, 2, 3])).toMatchObject({
      count: 3,
      minMs: 1,
      maxMs: 3,
      meanMs: 2,
    });
  });

  it('rejects single-run policies and validates every checked-in profile', () => {
    for (const profile of API_PERFORMANCE_PROFILES)
      expect(performanceProfile(profile.id)).toBe(profile);
    expect(() => aggregateTrials([trial(5)])).toThrow('at least five trials');
  });

  it('enforces absolute, variance, and baseline regression gates', () => {
    const baseline = aggregateTrials(
      Array.from({ length: 5 }, () => trial(10)),
    );
    const current = aggregateTrials(Array.from({ length: 5 }, () => trial(13)));
    const evaluation = evaluateBudget(
      current,
      {
        maxMedianP95Ms: 20,
        maxMedianP99Ms: 20,
        maxP95CoefficientOfVariation: 0.2,
        maxRegressionPercent: 15,
      },
      baseline,
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failures).toContain('p95_regression_exceeded');
  });

  it('flags unstable trial populations independently of latency', () => {
    const result = aggregateTrials([
      trial(1),
      trial(1),
      trial(1),
      trial(50),
      trial(50),
    ]);
    expect(
      evaluateBudget(result, {
        maxMedianP95Ms: 100,
        maxMedianP99Ms: 100,
        maxP95CoefficientOfVariation: 0.2,
        maxRegressionPercent: 15,
      }).failures,
    ).toContain('p95_variance_exceeded');
  });
});
