import { describe, expect, it } from 'vitest';
import {
  checkedInRealtimeProfiles,
  realtimeCapacityPolicy,
} from './realtime-policy.js';

describe('real-time capacity policy', () => {
  it('defines bounded connection, subscription, fan-out, and soak workloads', () => {
    for (const profile of checkedInRealtimeProfiles()) {
      const policy = realtimeCapacityPolicy(profile.id);
      expect(policy.connections).toBeGreaterThanOrEqual(2);
      expect(policy.subscriptionsPerConnection).toBeLessThanOrEqual(32);
      expect(policy.measuredEvents).toBeGreaterThanOrEqual(10);
      expect(policy.reconnectConnections).toBeLessThanOrEqual(
        policy.connections,
      );
    }
    expect(realtimeCapacityPolicy('soak').soakSeconds).toBeGreaterThanOrEqual(
      600,
    );
  });

  it('accepts reproducible bounded overrides and rejects accidental overloads', () => {
    expect(
      realtimeCapacityPolicy('ci', {
        NEXA_RT_CONNECTIONS: '100',
        NEXA_RT_SUBSCRIPTIONS: '4',
        NEXA_RT_EVENTS: '200',
      }),
    ).toMatchObject({
      connections: 100,
      subscriptionsPerConnection: 4,
      measuredEvents: 200,
    });
    expect(() =>
      realtimeCapacityPolicy('ci', { NEXA_RT_CONNECTIONS: '5001' }),
    ).toThrow('safe bounds');
    expect(() =>
      realtimeCapacityPolicy('soak', { NEXA_RT_SOAK_SECONDS: '599' }),
    ).toThrow('safe bounds');
  });
});
