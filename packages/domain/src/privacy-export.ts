import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';

export type ExportJobStatus =
  'queued' | 'running' | 'ready' | 'failed' | 'revoked' | 'expired';

export interface ExportJob {
  id: string;
  kind: 'user' | 'community';
  requesterId: string;
  subjectId: string;
  idempotencyKey: string;
  status: ExportJobStatus;
  schemaVersion: 1;
  objectReference: string | null;
  manifestDigest: string | null;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  failureCode: string | null;
  version: number;
}

export interface ExportResource {
  name: string;
  records: readonly Record<string, unknown>[];
}

export interface ExportManifest {
  schemaVersion: 1;
  exportId: string;
  generatedAt: string;
  subjectId: string;
  resources: { name: string; count: number; sha256: string }[];
}

export interface ExportStore {
  create(job: ExportJob): Promise<ExportJob>;
  findById(id: string): Promise<ExportJob | undefined>;
  findByIdempotencyKey(
    requesterId: string,
    key: string,
  ): Promise<ExportJob | undefined>;
  countCreatedSince(requesterId: string, since: string): Promise<number>;
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<ExportJob>,
  ): Promise<ExportJob | undefined>;
  putEncryptedObject(jobId: string, payload: Uint8Array): Promise<string>;
  getEncryptedObject(reference: string): Promise<Uint8Array | undefined>;
  deleteObject(reference: string): Promise<void>;
  audit(event: {
    id: string;
    actorId: string;
    exportId: string;
    action: string;
    outcome: 'succeeded' | 'rejected';
    correlationId: string;
    occurredAt: string;
  }): Promise<void>;
}

export interface ExportAuthorization {
  assertRecentAuthentication(
    actorId: string,
    authenticatedAt: string,
    now: Date,
  ): Promise<void>;
  assertUserExport(actorId: string, subjectId: string): Promise<void>;
}

export interface ExportKeyProvider {
  keyFor(jobId: string): Promise<Uint8Array>;
}

export interface CommunityExportAuthorization {
  assertRecentAuthentication(
    actorId: string,
    authenticatedAt: string,
    now: Date,
  ): Promise<void>;
  assertCommunityExport(actorId: string, communityId: string): Promise<void>;
}

function boundedKey(value: string): string {
  const result = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(result))
    throw new Error('invalid_idempotency_key');
  return result;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function buildExportArchive(
  job: ExportJob,
  resources: readonly ExportResource[],
  generatedAt: string,
): { archive: Uint8Array; manifest: ExportManifest; digest: string } {
  if (resources.length > 50) throw new Error('export_too_large');
  const normalized = [...resources]
    .map((resource) => {
      if (
        !/^[a-z][a-z0-9_-]{0,63}$/.test(resource.name) ||
        resource.records.length > 100_000
      )
        throw new Error('export_too_large');
      return { name: resource.name, records: [...resource.records] };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const manifest: ExportManifest = {
    schemaVersion: 1,
    exportId: job.id,
    generatedAt,
    subjectId: job.subjectId,
    resources: normalized.map((resource) => ({
      name: resource.name,
      count: resource.records.length,
      sha256: createHash('sha256')
        .update(canonical(resource.records))
        .digest('hex'),
    })),
  };
  const serialized = Buffer.from(
    canonical({ manifest, resources: normalized }),
  );
  if (serialized.byteLength > 100 * 1024 * 1024)
    throw new Error('export_too_large');
  return {
    archive: serialized,
    manifest,
    digest: createHash('sha256').update(serialized).digest('hex'),
  };
}

export function encryptExport(
  plaintext: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  if (key.byteLength !== 32) throw new Error('invalid_export_key');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(
    JSON.stringify({
      algorithm: 'A256GCM',
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: encrypted.toString('base64url'),
    }),
  );
}

export class UserExportService {
  constructor(
    private readonly store: ExportStore,
    private readonly authorization: ExportAuthorization,
    private readonly keys: ExportKeyProvider,
    private readonly collect: (
      subjectId: string,
    ) => Promise<readonly ExportResource[]>,
  ) {}

  async request(input: {
    actorId: string;
    subjectId: string;
    authenticatedAt: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<ExportJob> {
    const key = boundedKey(input.idempotencyKey);
    await this.authorization.assertRecentAuthentication(
      input.actorId,
      input.authenticatedAt,
      input.now,
    );
    await this.authorization.assertUserExport(input.actorId, input.subjectId);
    const duplicate = await this.store.findByIdempotencyKey(input.actorId, key);
    if (duplicate) {
      if (duplicate.subjectId !== input.subjectId || duplicate.kind !== 'user')
        throw new Error('idempotency_conflict');
      return duplicate;
    }
    const since = new Date(input.now.getTime() - 86_400_000).toISOString();
    if ((await this.store.countCreatedSince(input.actorId, since)) >= 3)
      throw new Error('export_rate_limited');
    const job = await this.store.create({
      id: randomUUID(),
      kind: 'user',
      requesterId: input.actorId,
      subjectId: input.subjectId,
      idempotencyKey: key,
      status: 'queued',
      schemaVersion: 1,
      objectReference: null,
      manifestDigest: null,
      createdAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + 7 * 86_400_000).toISOString(),
      completedAt: null,
      failureCode: null,
      version: 1,
    });
    await this.store.audit({
      id: randomUUID(),
      actorId: input.actorId,
      exportId: job.id,
      action: 'user_export.request',
      outcome: 'succeeded',
      correlationId: input.correlationId,
      occurredAt: input.now.toISOString(),
    });
    return job;
  }

  async process(jobId: string, now: Date): Promise<ExportJob> {
    const current = await this.store.findById(jobId);
    if (!current) throw new Error('export_not_found');
    if (
      current.status === 'ready' ||
      current.status === 'revoked' ||
      current.status === 'expired'
    )
      return current;
    const running = await this.store.update(jobId, current.version, {
      status: 'running',
    });
    if (!running) throw new Error('stale_export_job');
    let reference: string | null = null;
    try {
      const resources = await this.collect(running.subjectId);
      const built = buildExportArchive(running, resources, now.toISOString());
      const encrypted = encryptExport(
        built.archive,
        await this.keys.keyFor(jobId),
      );
      reference = await this.store.putEncryptedObject(jobId, encrypted);
      const ready = await this.store.update(jobId, running.version, {
        status: 'ready',
        objectReference: reference,
        manifestDigest: built.digest,
        completedAt: now.toISOString(),
      });
      if (!ready) throw new Error('stale_export_job');
      return ready;
    } catch (error) {
      if (reference) await this.store.deleteObject(reference);
      await this.store.update(jobId, running.version, {
        status: 'failed',
        objectReference: null,
        failureCode: 'generation_failed',
      });
      throw error;
    }
  }

  async retrieve(input: {
    actorId: string;
    jobId: string;
    authenticatedAt: string;
    correlationId: string;
    now: Date;
  }): Promise<Uint8Array> {
    await this.authorization.assertRecentAuthentication(
      input.actorId,
      input.authenticatedAt,
      input.now,
    );
    const job = await this.store.findById(input.jobId);
    if (!job || job.requesterId !== input.actorId)
      throw new Error('export_not_found');
    await this.authorization.assertUserExport(input.actorId, job.subjectId);
    if (
      job.status !== 'ready' ||
      !job.objectReference ||
      input.now >= new Date(job.expiresAt)
    )
      throw new Error('export_not_found');
    const payload = await this.store.getEncryptedObject(job.objectReference);
    if (!payload) throw new Error('export_not_found');
    await this.store.audit({
      id: randomUUID(),
      actorId: input.actorId,
      exportId: job.id,
      action: 'user_export.retrieve',
      outcome: 'succeeded',
      correlationId: input.correlationId,
      occurredAt: input.now.toISOString(),
    });
    return payload;
  }

  async revoke(
    actorId: string,
    jobId: string,
    correlationId: string,
    now: Date,
  ): Promise<ExportJob> {
    const job = await this.store.findById(jobId);
    if (!job || job.requesterId !== actorId)
      throw new Error('export_not_found');
    if (job.status === 'revoked') return job;
    if (job.objectReference) await this.store.deleteObject(job.objectReference);
    const revoked = await this.store.update(job.id, job.version, {
      status: 'revoked',
      objectReference: null,
    });
    if (!revoked) throw new Error('stale_export_job');
    await this.store.audit({
      id: randomUUID(),
      actorId,
      exportId: job.id,
      action: 'user_export.revoke',
      outcome: 'succeeded',
      correlationId,
      occurredAt: now.toISOString(),
    });
    return revoked;
  }
}

const COMMUNITY_EXPORT_RESOURCES = new Set([
  'community',
  'spaces',
  'roles',
  'memberships',
  'messages',
  'moderation_actions',
  'audit_events',
]);
const PRIVATE_EXPORT_FIELDS = new Set([
  'email',
  'address',
  'ipAddress',
  'passwordHash',
  'sessionToken',
  'reporterId',
  'evidenceBody',
  'directConversationId',
]);

/** Removes non-administrative resources and private fields by default. */
export function minimizeCommunityExport(
  resources: readonly ExportResource[],
): ExportResource[] {
  return resources
    .filter((resource) => COMMUNITY_EXPORT_RESOURCES.has(resource.name))
    .map((resource) => ({
      name: resource.name,
      records: resource.records.map((record) =>
        Object.fromEntries(
          Object.entries(record).filter(
            ([key]) => !PRIVATE_EXPORT_FIELDS.has(key),
          ),
        ),
      ),
    }));
}

export class CommunityExportService {
  constructor(
    private readonly store: ExportStore,
    private readonly authorization: CommunityExportAuthorization,
    private readonly keys: ExportKeyProvider,
    private readonly collect: (
      communityId: string,
    ) => Promise<readonly ExportResource[]>,
  ) {}

  async request(input: {
    actorId: string;
    communityId: string;
    authenticatedAt: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<ExportJob> {
    const key = boundedKey(input.idempotencyKey);
    await this.authorization.assertRecentAuthentication(
      input.actorId,
      input.authenticatedAt,
      input.now,
    );
    await this.authorization.assertCommunityExport(
      input.actorId,
      input.communityId,
    );
    const existing = await this.store.findByIdempotencyKey(input.actorId, key);
    if (existing) {
      if (
        existing.kind !== 'community' ||
        existing.subjectId !== input.communityId
      )
        throw new Error('idempotency_conflict');
      return existing;
    }
    if (
      (await this.store.countCreatedSince(
        input.actorId,
        new Date(input.now.getTime() - 86_400_000).toISOString(),
      )) >= 3
    )
      throw new Error('export_rate_limited');
    const job = await this.store.create({
      id: randomUUID(),
      kind: 'community',
      requesterId: input.actorId,
      subjectId: input.communityId,
      idempotencyKey: key,
      status: 'queued',
      schemaVersion: 1,
      objectReference: null,
      manifestDigest: null,
      createdAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + 48 * 3_600_000).toISOString(),
      completedAt: null,
      failureCode: null,
      version: 1,
    });
    await this.audit(
      input.actorId,
      job.id,
      'community_export.request',
      input.correlationId,
      input.now,
    );
    return job;
  }

  async process(jobId: string, now: Date): Promise<ExportJob> {
    const current = await this.store.findById(jobId);
    if (!current || current.kind !== 'community')
      throw new Error('export_not_found');
    if (
      current.status === 'ready' ||
      current.status === 'revoked' ||
      current.status === 'expired'
    )
      return current;
    await this.authorization.assertCommunityExport(
      current.requesterId,
      current.subjectId,
    );
    const running = await this.store.update(jobId, current.version, {
      status: 'running',
    });
    if (!running) throw new Error('stale_export_job');
    let reference: string | null = null;
    try {
      const resources = minimizeCommunityExport(
        await this.collect(running.subjectId),
      );
      const built = buildExportArchive(running, resources, now.toISOString());
      const encrypted = encryptExport(
        built.archive,
        await this.keys.keyFor(jobId),
      );
      reference = await this.store.putEncryptedObject(jobId, encrypted);
      const ready = await this.store.update(jobId, running.version, {
        status: 'ready',
        objectReference: reference,
        manifestDigest: built.digest,
        completedAt: now.toISOString(),
      });
      if (!ready) throw new Error('stale_export_job');
      return ready;
    } catch (error) {
      if (reference) await this.store.deleteObject(reference);
      await this.store.update(jobId, running.version, {
        status: 'failed',
        objectReference: null,
        failureCode: 'generation_failed',
      });
      throw error;
    }
  }

  async retrieve(input: {
    actorId: string;
    jobId: string;
    authenticatedAt: string;
    correlationId: string;
    now: Date;
  }): Promise<Uint8Array> {
    await this.authorization.assertRecentAuthentication(
      input.actorId,
      input.authenticatedAt,
      input.now,
    );
    const job = await this.store.findById(input.jobId);
    if (!job || job.kind !== 'community' || job.requesterId !== input.actorId)
      throw new Error('export_not_found');
    await this.authorization.assertCommunityExport(
      input.actorId,
      job.subjectId,
    );
    if (
      job.status !== 'ready' ||
      !job.objectReference ||
      input.now >= new Date(job.expiresAt)
    )
      throw new Error('export_not_found');
    const payload = await this.store.getEncryptedObject(job.objectReference);
    if (!payload) throw new Error('export_not_found');
    await this.audit(
      input.actorId,
      job.id,
      'community_export.retrieve',
      input.correlationId,
      input.now,
    );
    return payload;
  }

  async revoke(
    actorId: string,
    jobId: string,
    correlationId: string,
    now: Date,
  ): Promise<ExportJob> {
    const job = await this.store.findById(jobId);
    if (!job || job.kind !== 'community' || job.requesterId !== actorId)
      throw new Error('export_not_found');
    await this.authorization.assertCommunityExport(actorId, job.subjectId);
    if (job.status === 'revoked') return job;
    if (job.objectReference) await this.store.deleteObject(job.objectReference);
    const revoked = await this.store.update(job.id, job.version, {
      status: 'revoked',
      objectReference: null,
    });
    if (!revoked) throw new Error('stale_export_job');
    await this.audit(
      actorId,
      job.id,
      'community_export.revoke',
      correlationId,
      now,
    );
    return revoked;
  }

  private async audit(
    actorId: string,
    exportId: string,
    action: string,
    correlationId: string,
    now: Date,
  ): Promise<void> {
    await this.store.audit({
      id: randomUUID(),
      actorId,
      exportId,
      action,
      outcome: 'succeeded',
      correlationId,
      occurredAt: now.toISOString(),
    });
  }
}
