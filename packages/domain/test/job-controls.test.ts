import { describe, expect, it } from 'vitest';
import { JobControlService, type AdminJob } from '../src/administration.js';

describe('job queue controls', () => {
  it('sanitizes visibility, bounds metrics, and uses cooperative cancellation', async () => {
    let job: AdminJob = {
      id: 'j',
      kind: 'export',
      status: 'running',
      attempts: 1,
      maxAttempts: 3,
      createdAt: '2026-01-01',
      startedAt: '2026-01-01',
      completedAt: null,
      deduplicationKey: 'opaque',
      version: 1,
    };
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const store = {
      effectiveConfiguration: async () => ({}),
      dependencyHealth: async () => ({}),
      migrationVersion: async () => ({ current: 39, expected: 39 }),
      latestAuditHash: async () => undefined,
      appendAudit: async () => {},
      listJobs: async () => ({ items: [job], nextCursor: null }),
      findJob: async () => job,
      retryJob: async () => undefined,
      requestCancellation: async (_id: string, version: number) =>
        job.version === version
          ? (job = { ...job, status: 'cancel_requested', version: version + 1 })
          : undefined,
      queueMetrics: async () => ({
        queued: 5,
        running: 3,
        oldestAgeSeconds: 90,
        capacity: 2,
      }),
    };
    const service = new JobControlService(store, {
      assertPermission: async () => {},
      assertRecentAuth: async () => {},
    });
    /* eslint-enable @typescript-eslint/require-await */
    expect(await service.metrics('admin')).toMatchObject({ saturation: 1 });
    expect(
      (await service.cancel('admin', 'j', 1, 'recent', 'c', new Date())).status,
    ).toBe('cancel_requested');
    expect(
      JSON.stringify((await service.list('admin', { limit: 10 })).items),
    ).not.toContain('payload');
  });
});
