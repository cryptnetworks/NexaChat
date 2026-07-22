import { createHash, randomUUID } from 'node:crypto';

export type NotificationKind =
  'mention' | 'reply' | 'invite' | 'moderation_outcome';
export type NotificationPreferenceScope =
  'account' | 'community' | 'category' | 'space';
export interface NotificationPreference {
  accountId: string;
  scopeType: NotificationPreferenceScope;
  scopeId: string;
  mode: 'all' | 'mentions' | 'none';
  mutedUntil: string | null;
  version: number;
  updatedAt: string;
}
export interface NotificationPreferenceStore {
  find(
    accountId: string,
    scopeType: NotificationPreferenceScope,
    scopeId: string,
  ): Promise<NotificationPreference | undefined>;
  save(
    value: NotificationPreference,
    expectedVersion?: number,
  ): Promise<NotificationPreference | undefined>;
}
export interface NotificationRecord {
  id: string;
  accountId: string;
  kind: NotificationKind;
  scopeId: string | null;
  resourceId: string;
  actorIds: string[];
  count: number;
  deduplicationKey: string;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  archivedAt: string | null;
  expiresAt: string;
  version: number;
}
export interface NotificationStore {
  findDeduplicated(
    accountId: string,
    key: string,
  ): Promise<NotificationRecord | undefined>;
  create(value: NotificationRecord): Promise<NotificationRecord>;
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<NotificationRecord>,
  ): Promise<NotificationRecord | undefined>;
  find(id: string): Promise<NotificationRecord | undefined>;
  list(
    accountId: string,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: NotificationRecord[]; nextCursor: string | null }>;
  transaction<T>(work: (store: NotificationStore) => Promise<T>): Promise<T>;
}
export interface NotificationAuthorization {
  mayNotify(
    accountId: string,
    resourceId: string,
    kind: NotificationKind,
  ): Promise<boolean>;
  mayView(accountId: string, resourceId: string): Promise<boolean>;
}

const dedupe = (input: {
  accountId: string;
  kind: NotificationKind;
  resourceId: string;
  aggregationKey?: string;
}): string =>
  createHash('sha256')
    .update(
      `${input.accountId}:${input.kind}:${input.resourceId}:${input.aggregationKey ?? ''}`,
    )
    .digest('hex');

export class NotificationService {
  constructor(
    private readonly store: NotificationStore,
    private readonly authorization: NotificationAuthorization,
  ) {}
  async create(input: {
    accountId: string;
    kind: NotificationKind;
    scopeId?: string | null;
    resourceId: string;
    actorId: string;
    aggregationKey?: string;
    now: Date;
  }): Promise<NotificationRecord | null> {
    if (
      !(await this.authorization.mayNotify(
        input.accountId,
        input.resourceId,
        input.kind,
      ))
    )
      return null;
    const key = dedupe(input);
    return this.store.transaction(async (store) => {
      if (
        !(await this.authorization.mayNotify(
          input.accountId,
          input.resourceId,
          input.kind,
        ))
      )
        return null;
      const existing = await store.findDeduplicated(input.accountId, key);
      if (
        existing &&
        !existing.archivedAt &&
        input.now < new Date(existing.expiresAt)
      ) {
        const actors = [
          ...new Set([...existing.actorIds, input.actorId]),
        ].slice(-20);
        const updated = await store.update(existing.id, existing.version, {
          actorIds: actors,
          count: Math.min(10_000, existing.count + 1),
          updatedAt: input.now.toISOString(),
        });
        if (!updated) throw new Error('stale_notification');
        return updated;
      }
      return store.create({
        id: randomUUID(),
        accountId: input.accountId,
        kind: input.kind,
        scopeId: input.scopeId ?? null,
        resourceId: input.resourceId,
        actorIds: [input.actorId],
        count: 1,
        deduplicationKey: key,
        createdAt: input.now.toISOString(),
        updatedAt: input.now.toISOString(),
        readAt: null,
        archivedAt: null,
        expiresAt: new Date(
          input.now.getTime() + 90 * 86_400_000,
        ).toISOString(),
        version: 1,
      });
    });
  }
  async list(
    accountId: string,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: NotificationRecord[]; nextCursor: string | null }> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new Error('invalid_notification_page');
    const page = await this.store.list(accountId, input);
    const items: NotificationRecord[] = [];
    for (const item of page.items)
      if (
        !item.archivedAt &&
        (await this.authorization.mayView(accountId, item.resourceId))
      )
        items.push(item);
    return { items, nextCursor: page.nextCursor };
  }
  async mark(
    accountId: string,
    id: string,
    action: 'read' | 'archive',
    expectedVersion: number,
    now: Date,
  ): Promise<NotificationRecord> {
    const current = await this.store.find(id);
    if (!current || current.accountId !== accountId)
      throw new Error('notification_not_found');
    const patch =
      action === 'read'
        ? { readAt: current.readAt ?? now.toISOString() }
        : {
            archivedAt: current.archivedAt ?? now.toISOString(),
            readAt: current.readAt ?? now.toISOString(),
          };
    const updated = await this.store.update(id, expectedVersion, patch);
    if (!updated) throw new Error('stale_notification');
    return updated;
  }
}

export class NotificationPreferenceService {
  constructor(private readonly store: NotificationPreferenceStore) {}
  async update(
    accountId: string,
    input: Omit<
      NotificationPreference,
      'accountId' | 'version' | 'updatedAt'
    > & { expectedVersion?: number },
    now: Date,
  ): Promise<NotificationPreference> {
    const current = await this.store.find(
      accountId,
      input.scopeType,
      input.scopeId,
    );
    if (current && input.expectedVersion === undefined)
      throw new Error('stale_notification_preference');
    if (
      input.mutedUntil &&
      new Date(input.mutedUntil).getTime() > now.getTime() + 365 * 86_400_000
    )
      throw new Error('invalid_notification_preference');
    const saved = await this.store.save(
      {
        accountId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        mode: input.mode,
        mutedUntil: input.mutedUntil,
        version: current ? current.version + 1 : 1,
        updatedAt: now.toISOString(),
      },
      input.expectedVersion,
    );
    if (!saved) throw new Error('stale_notification_preference');
    return saved;
  }
  async effective(
    accountId: string,
    scopes: {
      communityId?: string;
      categoryId?: string;
      spaceId?: string;
    },
    kind: NotificationKind,
    now: Date,
  ): Promise<{
    deliver: boolean;
    mode: NotificationPreference['mode'];
    muted: boolean;
  }> {
    const candidates = [
      scopes.spaceId
        ? await this.store.find(accountId, 'space', scopes.spaceId)
        : undefined,
      scopes.categoryId
        ? await this.store.find(accountId, 'category', scopes.categoryId)
        : undefined,
      scopes.communityId
        ? await this.store.find(accountId, 'community', scopes.communityId)
        : undefined,
      await this.store.find(accountId, 'account', accountId),
    ];
    const selected = candidates.find((value): value is NotificationPreference =>
      Boolean(value),
    ) ?? { mode: 'mentions' as const, mutedUntil: null };
    const muted = Boolean(
      selected.mutedUntil && now < new Date(selected.mutedUntil),
    );
    const mention =
      kind === 'mention' || kind === 'reply' || kind === 'moderation_outcome';
    return {
      mode: selected.mode,
      muted,
      deliver:
        !muted &&
        selected.mode !== 'none' &&
        (selected.mode === 'all' || mention),
    };
  }
}
