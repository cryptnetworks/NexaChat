import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CommunityExportService,
  minimizeCommunityExport,
  type ExportJob,
  type ExportStore,
} from '../src/privacy-export.js';

class Store implements ExportStore {
  jobs = new Map<string, ExportJob>();
  objects = new Map<string, Uint8Array>();
  events: string[] = [];
  /* eslint-disable @typescript-eslint/require-await -- storage-port parity */
  create = async (job: ExportJob) => (this.jobs.set(job.id, job), job);
  findById = async (id: string) => this.jobs.get(id);
  findByIdempotencyKey = async (actor: string, key: string) =>
    [...this.jobs.values()].find(
      (job) => job.requesterId === actor && job.idempotencyKey === key,
    );
  countCreatedSince = async (actor: string, since: string) =>
    [...this.jobs.values()].filter(
      (job) => job.requesterId === actor && job.createdAt >= since,
    ).length;
  update = async (id: string, version: number, patch: Partial<ExportJob>) => {
    const current = this.jobs.get(id);
    if (!current || current.version !== version) return undefined;
    const next = { ...current, ...patch, version: version + 1 };
    this.jobs.set(id, next);
    return next;
  };
  putEncryptedObject = async (id: string, value: Uint8Array) => (
    this.objects.set(id, value),
    id
  );
  getEncryptedObject = async (id: string) => this.objects.get(id);
  deleteObject = async (id: string) => void this.objects.delete(id);
  audit = async (event: { action: string }) =>
    void this.events.push(event.action);
  /* eslint-enable @typescript-eslint/require-await */
}

describe('community administration exports', () => {
  it('redacts private fields and excludes reports, evidence, and direct messages', () => {
    expect(
      minimizeCommunityExport([
        {
          name: 'memberships',
          records: [
            {
              accountId: 'u',
              email: 'private@example.test',
              address: 'secret',
            },
          ],
        },
        { name: 'reports', records: [{ id: 'r', reporterId: 'u' }] },
        { name: 'direct_messages', records: [{ id: 'dm' }] },
      ]),
    ).toEqual([{ name: 'memberships', records: [{ accountId: 'u' }] }]);
  });

  it('revalidates administration permission for workers and retrieval', async () => {
    const store = new Store();
    let allowed = true;
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const service = new CommunityExportService(
      store,
      {
        assertRecentAuthentication: async () => {},
        assertCommunityExport: async () => {
          if (!allowed) throw new Error('export_not_found');
        },
      },
      { keyFor: async () => randomBytes(32) },
      async () => [
        { name: 'community', records: [{ id: 'community' }] },
        { name: 'reports', records: [{ id: 'private-report' }] },
      ],
    );
    /* eslint-enable @typescript-eslint/require-await */
    const now = new Date('2026-01-01');
    const job = await service.request({
      actorId: 'admin',
      communityId: 'community',
      authenticatedAt: now.toISOString(),
      idempotencyKey: 'community-export-1',
      correlationId: 'c',
      now,
    });
    allowed = false;
    await expect(service.process(job.id, now)).rejects.toThrow(
      'export_not_found',
    );
    allowed = true;
    const ready = await service.process(job.id, now);
    allowed = false;
    await expect(
      service.retrieve({
        actorId: 'admin',
        jobId: ready.id,
        authenticatedAt: now.toISOString(),
        correlationId: 'r',
        now,
      }),
    ).rejects.toThrow('export_not_found');
  });

  it('uses privacy-preserving not-found errors for other requesters', async () => {
    const store = new Store();
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const service = new CommunityExportService(
      store,
      {
        assertRecentAuthentication: async () => {},
        assertCommunityExport: async () => {},
      },
      { keyFor: async () => randomBytes(32) },
      async () => [],
    );
    /* eslint-enable @typescript-eslint/require-await */
    const now = new Date('2026-01-01');
    const job = await service.request({
      actorId: 'admin',
      communityId: 'community',
      authenticatedAt: now.toISOString(),
      idempotencyKey: 'community-export-2',
      correlationId: 'c',
      now,
    });
    await service.process(job.id, now);
    await expect(
      service.retrieve({
        actorId: 'other',
        jobId: job.id,
        authenticatedAt: now.toISOString(),
        correlationId: 'x',
        now,
      }),
    ).rejects.toThrow('export_not_found');
  });
});
