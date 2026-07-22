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
