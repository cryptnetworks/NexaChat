import { createHash, randomUUID } from 'node:crypto';
export interface AdminAuthorization {
  assertPermission(actorId: string, permission: string): Promise<void>;
  assertRecentAuth(
    actorId: string,
    authenticatedAt: string,
    now: Date,
  ): Promise<void>;
}
export interface InstanceAudit {
  id: string;
  actorId: string;
  action: string;
  targetId: string | null;
  outcome: string;
  correlationId: string;
  occurredAt: string;
  previousHash: string | null;
  eventHash: string;
}
export interface AdminStore {
  effectiveConfiguration(): Promise<Record<string, unknown>>;
  dependencyHealth(): Promise<
    Record<string, 'healthy' | 'degraded' | 'unavailable'>
  >;
  migrationVersion(): Promise<{ current: number; expected: number }>;
  latestAuditHash(): Promise<string | undefined>;
  appendAudit(event: InstanceAudit): Promise<void>;
}
const SECRET_KEYS = /password|secret|token|key|url|address/i;
export class AdministrationService {
  constructor(
    protected readonly store: AdminStore,
    protected readonly authorization: AdminAuthorization,
  ) {}
  async overview(actorId: string): Promise<{
    configuration: Record<string, unknown>;
    dependencies: Record<string, string>;
    migration: { current: number; expected: number };
  }> {
    await this.authorization.assertPermission(actorId, 'instance.view');
    const raw = await this.store.effectiveConfiguration();
    return {
      configuration: Object.fromEntries(
        Object.entries(raw).map(([key, value]) => [
          key,
          SECRET_KEYS.test(key) ? '[configured]' : value,
        ]),
      ),
      dependencies: await this.store.dependencyHealth(),
      migration: await this.store.migrationVersion(),
    };
  }
  protected async sensitive(
    actorId: string,
    authenticatedAt: string,
    permission: string,
    now: Date,
  ): Promise<void> {
    await this.authorization.assertPermission(actorId, permission);
    await this.authorization.assertRecentAuth(actorId, authenticatedAt, now);
  }
  protected async audit(
    actorId: string,
    action: string,
    targetId: string | null,
    outcome: string,
    correlationId: string,
    now: Date,
  ): Promise<void> {
    const previousHash = (await this.store.latestAuditHash()) ?? null;
    const material = JSON.stringify({
      actorId,
      action,
      targetId,
      outcome,
      correlationId,
      occurredAt: now.toISOString(),
      previousHash,
    });
    await this.store.appendAudit({
      id: randomUUID(),
      actorId,
      action,
      targetId,
      outcome,
      correlationId,
      occurredAt: now.toISOString(),
      previousHash,
      eventHash: createHash('sha256').update(material).digest('hex'),
    });
  }
}

export interface AccountSuspension {
  id: string;
  actorId: string;
  accountId: string;
  reason: string;
  idempotencyKey: string;
  createdAt: string;
  expiresAt: string | null;
  restoredAt: string | null;
  version: number;
}
export interface SuspensionStore extends AdminStore {
  findSuspension(
    actorId: string,
    key: string,
  ): Promise<AccountSuspension | undefined>;
  createSuspension(value: AccountSuspension): Promise<AccountSuspension>;
  findSuspensionById(id: string): Promise<AccountSuspension | undefined>;
  restoreSuspension(
    id: string,
    expectedVersion: number,
    now: string,
  ): Promise<AccountSuspension | undefined>;
  assertNotLastAdministrator(accountId: string): Promise<void>;
  revokeSessions(accountId: string, now: string): Promise<void>;
  publishAuthorizationInvalidation(accountId: string): Promise<void>;
}
export class AccountSuspensionService extends AdministrationService {
  constructor(
    private readonly suspensions: SuspensionStore,
    authorization: AdminAuthorization,
  ) {
    super(suspensions, authorization);
  }
  async suspend(input: {
    actorId: string;
    accountId: string;
    reason: string;
    idempotencyKey: string;
    expiresAt?: string | null;
    authenticatedAt: string;
    correlationId: string;
    now: Date;
  }): Promise<AccountSuspension> {
    await this.sensitive(
      input.actorId,
      input.authenticatedAt,
      'instance.account.suspend',
      input.now,
    );
    if (input.actorId === input.accountId) throw new Error('protected_account');
    const reason = input.reason.trim().replace(/\s+/g, ' ').normalize('NFC');
    if (
      !reason ||
      reason.length > 500 ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)
    )
      throw new Error('invalid_suspension');
    if (
      input.expiresAt &&
      (new Date(input.expiresAt) <= input.now ||
        new Date(input.expiresAt).getTime() >
          input.now.getTime() + 365 * 86_400_000)
    )
      throw new Error('invalid_suspension');
    const retry = await this.suspensions.findSuspension(
      input.actorId,
      input.idempotencyKey,
    );
    if (retry) return retry;
    await this.suspensions.assertNotLastAdministrator(input.accountId);
    const value = await this.suspensions.createSuspension({
      id: randomUUID(),
      actorId: input.actorId,
      accountId: input.accountId,
      reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now.toISOString(),
      expiresAt: input.expiresAt ?? null,
      restoredAt: null,
      version: 1,
    });
    await this.suspensions.revokeSessions(
      input.accountId,
      input.now.toISOString(),
    );
    await this.suspensions.publishAuthorizationInvalidation(input.accountId);
    await this.audit(
      input.actorId,
      'account.suspend',
      input.accountId,
      'succeeded',
      input.correlationId,
      input.now,
    );
    return value;
  }
  async restore(
    actorId: string,
    id: string,
    expectedVersion: number,
    authenticatedAt: string,
    correlationId: string,
    now: Date,
  ): Promise<AccountSuspension> {
    await this.sensitive(
      actorId,
      authenticatedAt,
      'instance.account.suspend',
      now,
    );
    const current = await this.suspensions.findSuspensionById(id);
    if (!current) throw new Error('suspension_not_found');
    if (current.restoredAt) return current;
    const restored = await this.suspensions.restoreSuspension(
      id,
      expectedVersion,
      now.toISOString(),
    );
    if (!restored) throw new Error('stale_suspension');
    await this.suspensions.publishAuthorizationInvalidation(current.accountId);
    await this.audit(
      actorId,
      'account.restore',
      current.accountId,
      'succeeded',
      correlationId,
      now,
    );
    return restored;
  }
}

export type RegistrationMode = 'open' | 'invite_only' | 'closed';
export interface RegistrationPolicy {
  mode: RegistrationMode;
  updatedBy: string;
  updatedAt: string;
  version: number;
}
export interface RegistrationPolicyStore extends AdminStore {
  policy(): Promise<RegistrationPolicy | undefined>;
  savePolicy(
    value: RegistrationPolicy,
    expectedVersion?: number,
  ): Promise<RegistrationPolicy | undefined>;
}
export class RegistrationPolicyService extends AdministrationService {
  constructor(
    private readonly policies: RegistrationPolicyStore,
    authorization: AdminAuthorization,
  ) {
    super(policies, authorization);
  }
  publicStatus(): Promise<{ mode: RegistrationMode }> {
    return this.policies
      .policy()
      .then((value) => ({ mode: value?.mode ?? 'closed' }));
  }
  async assertRegistrationAllowed(invitationValid: boolean): Promise<void> {
    const { mode } = await this.publicStatus();
    if (mode === 'closed' || (mode === 'invite_only' && !invitationValid))
      throw new Error('registration_unavailable');
  }
  async update(
    actorId: string,
    mode: RegistrationMode,
    expectedVersion: number | undefined,
    authenticatedAt: string,
    correlationId: string,
    now: Date,
  ): Promise<RegistrationPolicy> {
    await this.sensitive(
      actorId,
      authenticatedAt,
      'instance.registration.manage',
      now,
    );
    const current = await this.policies.policy();
    if (current && expectedVersion === undefined)
      throw new Error('stale_registration_policy');
    const saved = await this.policies.savePolicy(
      {
        mode,
        updatedBy: actorId,
        updatedAt: now.toISOString(),
        version: current ? current.version + 1 : 1,
      },
      expectedVersion,
    );
    if (!saved) throw new Error('stale_registration_policy');
    await this.audit(
      actorId,
      'registration_policy.update',
      null,
      'succeeded',
      correlationId,
      now,
    );
    return saved;
  }
}

export interface MaintenanceState {
  active: boolean;
  retryAfterSeconds: number;
  reasonCode: string;
  updatedBy: string;
  updatedAt: string;
  version: number;
}
export interface MaintenanceStore extends AdminStore {
  maintenance(): Promise<MaintenanceState | undefined>;
  saveMaintenance(
    value: MaintenanceState,
    expectedVersion?: number,
  ): Promise<MaintenanceState | undefined>;
  publishMaintenance(value: MaintenanceState): Promise<void>;
}
export class MaintenanceService extends AdministrationService {
  constructor(
    private readonly maintenanceStore: MaintenanceStore,
    authorization: AdminAuthorization,
  ) {
    super(maintenanceStore, authorization);
  }
  async update(
    actorId: string,
    input: {
      active: boolean;
      retryAfterSeconds: number;
      reasonCode: string;
      expectedVersion?: number;
      authenticatedAt: string;
      correlationId: string;
      now: Date;
    },
  ): Promise<MaintenanceState> {
    await this.sensitive(
      actorId,
      input.authenticatedAt,
      'instance.maintenance.manage',
      input.now,
    );
    if (
      !Number.isInteger(input.retryAfterSeconds) ||
      input.retryAfterSeconds < 5 ||
      input.retryAfterSeconds > 3600 ||
      !/^[a-z0-9_]{3,64}$/.test(input.reasonCode)
    )
      throw new Error('invalid_maintenance_state');
    const current = await this.maintenanceStore.maintenance();
    if (current && input.expectedVersion === undefined)
      throw new Error('stale_maintenance_state');
    const saved = await this.maintenanceStore.saveMaintenance(
      {
        active: input.active,
        retryAfterSeconds: input.retryAfterSeconds,
        reasonCode: input.reasonCode,
        updatedBy: actorId,
        updatedAt: input.now.toISOString(),
        version: current ? current.version + 1 : 1,
      },
      input.expectedVersion,
    );
    if (!saved) throw new Error('stale_maintenance_state');
    await this.maintenanceStore.publishMaintenance(saved);
    await this.audit(
      actorId,
      input.active ? 'maintenance.activate' : 'maintenance.deactivate',
      null,
      'succeeded',
      input.correlationId,
      input.now,
    );
    return saved;
  }
  async enforce(
    method: string,
    path: string,
    actorId?: string,
  ): Promise<{ retryAfterSeconds: number } | null> {
    const state = await this.maintenanceStore.maintenance();
    if (
      !state?.active ||
      (method === 'GET' && ['/health/live', '/health/ready'].includes(path))
    )
      return null;
    if (actorId) {
      try {
        await this.authorization.assertPermission(
          actorId,
          'instance.maintenance.bypass',
        );
        return null;
      } catch {
        /* deny below */
      }
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
    return { retryAfterSeconds: state.retryAfterSeconds };
  }
}

export type AdminJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled';
export interface AdminJob {
  id: string;
  kind: string;
  status: AdminJobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  deduplicationKey: string;
  version: number;
}
export interface JobControlStore extends AdminStore {
  listJobs(input: {
    limit: number;
    cursor?: string;
  }): Promise<{ items: AdminJob[]; nextCursor: string | null }>;
  findJob(id: string): Promise<AdminJob | undefined>;
  retryJob(id: string, expectedVersion: number): Promise<AdminJob | undefined>;
  requestCancellation(
    id: string,
    expectedVersion: number,
  ): Promise<AdminJob | undefined>;
  queueMetrics(): Promise<{
    queued: number;
    running: number;
    oldestAgeSeconds: number;
    capacity: number;
  }>;
}
export class JobControlService extends AdministrationService {
  constructor(
    private readonly jobs: JobControlStore,
    authorization: AdminAuthorization,
  ) {
    super(jobs, authorization);
  }
  async list(
    actorId: string,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: AdminJob[]; nextCursor: string | null }> {
    await this.authorization.assertPermission(actorId, 'instance.jobs.view');
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new Error('invalid_job_page');
    return this.jobs.listJobs(input);
  }
  async metrics(
    actorId: string,
  ): Promise<{
    queued: number;
    running: number;
    oldestAgeSeconds: number;
    saturation: number;
  }> {
    await this.authorization.assertPermission(actorId, 'instance.jobs.view');
    const value = await this.jobs.queueMetrics();
    return {
      queued: value.queued,
      running: value.running,
      oldestAgeSeconds: Math.max(0, value.oldestAgeSeconds),
      saturation:
        value.capacity > 0 ? Math.min(1, value.running / value.capacity) : 1,
    };
  }
  async retry(
    actorId: string,
    id: string,
    expectedVersion: number,
    authenticatedAt: string,
    correlationId: string,
    now: Date,
  ): Promise<AdminJob> {
    await this.sensitive(actorId, authenticatedAt, 'instance.jobs.manage', now);
    const current = await this.jobs.findJob(id);
    if (
      !current ||
      current.status !== 'failed' ||
      current.attempts >= current.maxAttempts
    )
      throw new Error('job_unavailable');
    const retried = await this.jobs.retryJob(id, expectedVersion);
    if (!retried) throw new Error('stale_job');
    await this.audit(actorId, 'job.retry', id, 'succeeded', correlationId, now);
    return retried;
  }
  async cancel(
    actorId: string,
    id: string,
    expectedVersion: number,
    authenticatedAt: string,
    correlationId: string,
    now: Date,
  ): Promise<AdminJob> {
    await this.sensitive(actorId, authenticatedAt, 'instance.jobs.manage', now);
    const current = await this.jobs.findJob(id);
    if (
      !current ||
      !['queued', 'running', 'cancel_requested'].includes(current.status)
    )
      throw new Error('job_unavailable');
    if (current.status === 'cancel_requested') return current;
    const cancelled = await this.jobs.requestCancellation(id, expectedVersion);
    if (!cancelled) throw new Error('stale_job');
    await this.audit(
      actorId,
      'job.cancel.request',
      id,
      'succeeded',
      correlationId,
      now,
    );
    return cancelled;
  }
}
