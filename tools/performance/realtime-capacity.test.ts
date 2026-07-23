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
      expect(policy.spaces).toBeGreaterThanOrEqual(
        policy.subscriptionsPerConnection,
      );
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
        NEXA_RT_SPACES: '20',
        NEXA_RT_SUBSCRIPTIONS: '4',
        NEXA_RT_SUBSCRIPTION_PATTERN: 'striped',
        NEXA_RT_EVENTS: '200',
      }),
    ).toMatchObject({
      connections: 100,
      spaces: 20,
      subscriptionsPerConnection: 4,
      subscriptionPattern: 'striped',
      measuredEvents: 200,
    });
    expect(() =>
      realtimeCapacityPolicy('ci', { NEXA_RT_CONNECTIONS: '5001' }),
    ).toThrow('safe bounds');
    expect(() =>
      realtimeCapacityPolicy('soak', { NEXA_RT_SOAK_SECONDS: '599' }),
    ).toThrow('safe bounds');
    expect(() =>
      realtimeCapacityPolicy('ci', {
        NEXA_RT_SPACES: '2',
        NEXA_RT_SUBSCRIPTIONS: '3',
      }),
    ).toThrow('safe bounds');
    expect(() =>
      realtimeCapacityPolicy('ci', {
        NEXA_RT_SUBSCRIPTION_PATTERN: 'random',
      }),
    ).toThrow('must be all or striped');
  });
});
