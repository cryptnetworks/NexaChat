import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  UserExportService,
  type ExportJob,
  type ExportStore,
} from '../src/privacy-export.js';

class MemoryExportStore implements ExportStore {
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
    this.objects.set(`private/${id}`, value),
    `private/${id}`
  );
  getEncryptedObject = async (reference: string) => this.objects.get(reference);
  deleteObject = async (reference: string) =>
    void this.objects.delete(reference);
  audit = async (event: { action: string }) =>
    void this.events.push(event.action);
  /* eslint-enable @typescript-eslint/require-await */
}

const setup = () => {
  const store = new MemoryExportStore();
  /* eslint-disable @typescript-eslint/require-await -- async adapter parity */
  const service = new UserExportService(
    store,
    {
      assertRecentAuthentication: async (actor, authenticatedAt, now) => {
        if (now.getTime() - new Date(authenticatedAt).getTime() > 600_000)
          throw new Error('recent_auth_required');
        if (!actor) throw new Error('unauthorized');
      },
      assertUserExport: async (actor, subject) => {
        if (actor !== subject) throw new Error('export_not_found');
      },
    },
    { keyFor: async () => randomBytes(32) },
    async (subject) => [
      { name: 'profile', records: [{ id: subject, displayName: 'User' }] },
    ],
  );
  /* eslint-enable @typescript-eslint/require-await */
  return { store, service };
};

describe('user data export', () => {
  it('queues idempotently, encrypts asynchronously, expires, audits, and revokes', async () => {
    const { store, service } = setup();
    const now = new Date('2026-01-01T00:00:00.000Z');
    const input = {
      actorId: 'user',
      subjectId: 'user',
      authenticatedAt: now.toISOString(),
      idempotencyKey: 'export-key-01',
      correlationId: 'corr',
      now,
    };
    const queued = await service.request(input);
    expect(await service.request(input)).toEqual(queued);
    const ready = await service.process(queued.id, now);
    expect(ready).toMatchObject({ status: 'ready', schemaVersion: 1 });
    const payload = await service.retrieve({
      actorId: 'user',
      jobId: ready.id,
      authenticatedAt: now.toISOString(),
      correlationId: 'retrieve',
      now,
    });
    expect(Buffer.from(payload).toString()).toContain('A256GCM');
    expect(Buffer.from(payload).toString()).not.toContain('displayName');
    const revoked = await service.revoke('user', ready.id, 'revoke', now);
    expect(revoked.objectReference).toBeNull();
    expect(store.objects.size).toBe(0);
    expect(store.events).toEqual([
      'user_export.request',
      'user_export.retrieve',
      'user_export.revoke',
    ]);
  });

  it('requires recent auth and never discloses another subject', async () => {
    const { service } = setup();
    const now = new Date('2026-01-01T01:00:00.000Z');
    await expect(
      service.request({
        actorId: 'user',
        subjectId: 'user',
        authenticatedAt: '2026-01-01T00:00:00.000Z',
        idempotencyKey: 'export-key-02',
        correlationId: 'c',
        now,
      }),
    ).rejects.toThrow('recent_auth_required');
    await expect(
      service.request({
        actorId: 'user',
        subjectId: 'other',
        authenticatedAt: now.toISOString(),
        idempotencyKey: 'export-key-03',
        correlationId: 'c',
        now,
      }),
    ).rejects.toThrow('export_not_found');
  });

  it('cleans partial objects after worker failure', async () => {
    const store = new MemoryExportStore();
    /* eslint-disable @typescript-eslint/require-await -- async adapter parity */
    const service = new UserExportService(
      store,
      {
        assertRecentAuthentication: async () => {},
        assertUserExport: async () => {},
      },
      { keyFor: async () => new Uint8Array(2) },
      async () => [{ name: 'profile', records: [] }],
    );
    /* eslint-enable @typescript-eslint/require-await */
    const now = new Date('2026-01-01');
    const queued = await service.request({
      actorId: 'u',
      subjectId: 'u',
      authenticatedAt: now.toISOString(),
      idempotencyKey: 'export-key-04',
      correlationId: 'c',
      now,
    });
    await expect(service.process(queued.id, now)).rejects.toThrow(
      'invalid_export_key',
    );
    expect((await store.findById(queued.id))?.status).toBe('failed');
    expect(store.objects.size).toBe(0);
  });
});
