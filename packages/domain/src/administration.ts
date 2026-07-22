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
  async overview(
    actorId: string,
  ): Promise<{
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
