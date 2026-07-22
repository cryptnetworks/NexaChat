import { describe, expect, it } from 'vitest';
import {
  MaintenanceService,
  type MaintenanceState,
} from '../src/administration.js';

describe('maintenance mode', () => {
  it('allows safe health/read paths, rejects writes with stable retry, and publishes changes', async () => {
    let state: MaintenanceState | undefined;
    let published = false;
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const store = {
      effectiveConfiguration: async () => ({}),
      dependencyHealth: async () => ({}),
      migrationVersion: async () => ({ current: 38, expected: 38 }),
      latestAuditHash: async () => undefined,
      appendAudit: async () => {},
      maintenance: async () => state,
      saveMaintenance: async (v: MaintenanceState) => (state = v),
      publishMaintenance: async () => {
        published = true;
      },
    };
    const service = new MaintenanceService(store, {
      assertPermission: async (_a, p) => {
        if (p === 'instance.maintenance.bypass') throw new Error('deny');
      },
      assertRecentAuth: async () => {},
    });
    /* eslint-enable @typescript-eslint/require-await */
    await service.update('admin', {
      active: true,
      retryAfterSeconds: 120,
      reasonCode: 'planned_upgrade',
      authenticatedAt: 'recent',
      correlationId: 'c',
      now: new Date('2026-01-01'),
    });
    expect(published).toBe(true);
    expect(await service.enforce('GET', '/health/ready')).toBeNull();
    expect(await service.enforce('GET', '/v1/messages')).toBeNull();
    expect(await service.enforce('POST', '/v1/messages', 'user')).toEqual({
      retryAfterSeconds: 120,
    });
  });
});
