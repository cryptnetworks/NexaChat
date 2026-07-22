export interface RealtimeCapacityPolicy {
  id: 'ci' | 'soak';
  description: string;
  connections: number;
  subscriptionsPerConnection: number;
  warmupEvents: number;
  measuredEvents: number;
  reconnectConnections: number;
  soakSeconds: number;
  thresholds: {
    maxConnectionP95Ms: number;
    maxReconnectP95Ms: number;
    maxDeliveryP95Ms: number;
    minDeliveriesPerSecond: number;
    maxRssBytesPerConnection: number;
    maxSingleCoreCpuPercent: number;
    maxQueueDepthPerConnection: number;
  };
}

const profiles: readonly RealtimeCapacityPolicy[] = [
  {
    id: 'ci',
    description:
      'Bounded two-instance regression profile on one host and one Node.js process',
    connections: 60,
    subscriptionsPerConnection: 3,
    warmupEvents: 10,
    measuredEvents: 100,
    reconnectConnections: 30,
    soakSeconds: 0,
    thresholds: {
      maxConnectionP95Ms: 1_000,
      maxReconnectP95Ms: 1_500,
      maxDeliveryP95Ms: 250,
      minDeliveriesPerSecond: 2_000,
      maxRssBytesPerConnection: 2_000_000,
      maxSingleCoreCpuPercent: 150,
      maxQueueDepthPerConnection: 128,
    },
  },
  {
    id: 'soak',
    description:
      'Release-candidate two-instance Valkey profile with sustained delivery and reconnect load',
    connections: 1_000,
    subscriptionsPerConnection: 8,
    warmupEvents: 100,
    measuredEvents: 6_000,
    reconnectConnections: 500,
    soakSeconds: 600,
    thresholds: {
      maxConnectionP95Ms: 2_000,
      maxReconnectP95Ms: 3_000,
      maxDeliveryP95Ms: 500,
      minDeliveriesPerSecond: 5_000,
      maxRssBytesPerConnection: 750_000,
      maxSingleCoreCpuPercent: 150,
      maxQueueDepthPerConnection: 8,
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
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum)
    throw new Error(`${name} is outside its safe bounds`);
  return parsed;
}

export function realtimeCapacityPolicy(
  id: string,
  env: NodeJS.ProcessEnv = {},
): RealtimeCapacityPolicy {
  const selected = profiles.find((profile) => profile.id === id);
  if (!selected) throw new Error('profile must be ci or soak');
  const connections = boundedInteger(
    env.NEXA_RT_CONNECTIONS,
    selected.connections,
    2,
    5_000,
    'NEXA_RT_CONNECTIONS',
  );
  const subscriptionsPerConnection = boundedInteger(
    env.NEXA_RT_SUBSCRIPTIONS,
    selected.subscriptionsPerConnection,
    1,
    32,
    'NEXA_RT_SUBSCRIPTIONS',
  );
  const warmupEvents = boundedInteger(
    env.NEXA_RT_WARMUP_EVENTS,
    selected.warmupEvents,
    1,
    1_000,
    'NEXA_RT_WARMUP_EVENTS',
  );
  const measuredEvents = boundedInteger(
    env.NEXA_RT_EVENTS,
    selected.measuredEvents,
    10,
    100_000,
    'NEXA_RT_EVENTS',
  );
  const reconnectConnections = boundedInteger(
    env.NEXA_RT_RECONNECT_CONNECTIONS,
    Math.min(selected.reconnectConnections, connections),
    1,
    connections,
    'NEXA_RT_RECONNECT_CONNECTIONS',
  );
  const soakSeconds = boundedInteger(
    env.NEXA_RT_SOAK_SECONDS,
    selected.soakSeconds,
    selected.id === 'soak' ? 600 : 0,
    3_600,
    'NEXA_RT_SOAK_SECONDS',
  );
  if (selected.id === 'soak' && soakSeconds < 600)
    throw new Error('the soak profile cannot be shorter than 600 seconds');
  return {
    ...selected,
    connections,
    subscriptionsPerConnection,
    warmupEvents,
    measuredEvents,
    reconnectConnections,
    soakSeconds,
  };
}

export function checkedInRealtimeProfiles(): readonly RealtimeCapacityPolicy[] {
  return profiles;
}
