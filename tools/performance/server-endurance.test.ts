import { describe, expect, it } from 'vitest';
import {
  checkedInServerProfiles,
  serverEndurancePolicy,
} from './server-policy.js';

describe('server endurance policy', () => {
  it('defines bounded pull-request, release, and soak profiles', () => {
    const profiles = checkedInServerProfiles();
    expect(profiles.map(({ id }) => id)).toEqual(['ci', 'release', 'soak']);
    for (const profile of profiles) {
      expect(profile.concurrentRequests).toBeLessThanOrEqual(256);
      expect(profile.maximumLatencySamples).toBeLessThanOrEqual(500_000);
      expect(profile.memorySampleIntervalMs).toBeGreaterThanOrEqual(500);
      expect(profile.budget.maxErrorRate).toBe(0);
      expect(profile.budget.maxMinimumFinalHeapGrowthBytes).toBeLessThan(
        profile.budget.maxPeakRssBytes,
      );
      expect(profile.budget.maxActiveResourceGrowth).toBe(4);
      expect(profile.budget.maxP95RegressionPercent).toBe(15);
    }
    expect(
      serverEndurancePolicy('soak').durationSeconds,
    ).toBeGreaterThanOrEqual(600);
  });

  it('accepts bounded overrides and rejects accidental overloads', () => {
    expect(
      serverEndurancePolicy('ci', {
        NEXA_SERVER_DURATION_SECONDS: '2',
        NEXA_SERVER_CONCURRENCY: '12',
        NEXA_SERVER_MESSAGES: '500',
      }),
    ).toMatchObject({
      durationSeconds: 2,
      concurrentRequests: 12,
      messageCount: 500,
    });
    expect(() =>
      serverEndurancePolicy('ci', { NEXA_SERVER_CONCURRENCY: '257' }),
    ).toThrow('safe bounds');
    expect(() =>
      serverEndurancePolicy('soak', { NEXA_SERVER_DURATION_SECONDS: '599' }),
    ).toThrow('safe bounds');
  });
});
