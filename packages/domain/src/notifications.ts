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
  transaction<T>(
    work: (store: NotificationPreferenceStore) => Promise<T>,
  ): Promise<T>;
}
export interface NotificationPreferenceAuthorization {
  mayConfigure(
    accountId: string,
    scopeType: NotificationPreferenceScope,
    scopeId: string,
  ): Promise<boolean>;
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
  mayView(
    accountId: string,
    resourceId: string,
    kind?: NotificationKind,
    scopeId?: string | null,
  ): Promise<boolean>;
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
        (await this.authorization.mayView(
          accountId,
          item.resourceId,
          item.kind,
          item.scopeId,
        ))
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
    return this.store.transaction(async (store) => {
      const current = await store.find(id);
      if (
        !current ||
        current.accountId !== accountId ||
        !(await this.authorization.mayView(
          accountId,
          current.resourceId,
          current.kind,
          current.scopeId,
        ))
      )
        throw new Error('notification_not_found');
      const patch =
        action === 'read'
          ? { readAt: current.readAt ?? now.toISOString() }
          : {
              archivedAt: current.archivedAt ?? now.toISOString(),
              readAt: current.readAt ?? now.toISOString(),
            };
      const updated = await store.update(id, expectedVersion, patch);
      if (!updated) throw new Error('stale_notification');
      return updated;
    });
  }
}

export class NotificationPreferenceService {
  constructor(
    private readonly store: NotificationPreferenceStore,
    private readonly authorization: NotificationPreferenceAuthorization,
  ) {}
  async update(
    accountId: string,
    input: Omit<
      NotificationPreference,
      'accountId' | 'version' | 'updatedAt'
    > & { expectedVersion?: number },
    now: Date,
  ): Promise<NotificationPreference> {
    if (
      input.mutedUntil &&
      new Date(input.mutedUntil).getTime() > now.getTime() + 365 * 86_400_000
    )
      throw new Error('invalid_notification_preference');
    return this.store.transaction(async (store) => {
      if (
        !(await this.authorization.mayConfigure(
          accountId,
          input.scopeType,
          input.scopeId,
        ))
      )
        throw new Error('notification_preference_not_found');
      const current = await store.find(
        accountId,
        input.scopeType,
        input.scopeId,
      );
      if (current && input.expectedVersion === undefined)
        throw new Error('stale_notification_preference');
      const saved = await store.save(
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
    });
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
    const allowed = async (
      type: NotificationPreferenceScope,
      scopeId: string | undefined,
    ) =>
      scopeId &&
      (await this.authorization.mayConfigure(accountId, type, scopeId))
        ? this.store.find(accountId, type, scopeId)
        : undefined;
    const candidates = [
      scopes.spaceId ? await allowed('space', scopes.spaceId) : undefined,
      scopes.categoryId
        ? await allowed('category', scopes.categoryId)
        : undefined,
      scopes.communityId
        ? await allowed('community', scopes.communityId)
        : undefined,
      await allowed('account', accountId),
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

export interface NotificationReadState {
  accountId: string;
  stream: string;
  sequence: number;
  eventId: string;
  updatedAt: string;
  version: number;
}
export interface NotificationReadStore {
  find(
    accountId: string,
    stream: string,
  ): Promise<NotificationReadState | undefined>;
  advance(
    value: NotificationReadState,
    expectedVersion?: number,
  ): Promise<NotificationReadState | undefined>;
  transaction<T>(
    work: (store: NotificationReadStore) => Promise<T>,
  ): Promise<T>;
}
export interface NotificationReadAuthorization {
  mayAccess(accountId: string, stream: string): Promise<boolean>;
}
export interface NotificationReadPublisher {
  publish(state: NotificationReadState): Promise<void>;
}
export async function advanceNotificationReadState(
  store: NotificationReadStore,
  input: {
    accountId: string;
    stream: string;
    sequence: number;
    eventId: string;
    now: Date;
  },
): Promise<NotificationReadState> {
  if (
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0 ||
    input.stream.length > 128
  )
    throw new Error('invalid_notification_read_state');
  const current = await store.find(input.accountId, input.stream);
  if (current && input.sequence <= current.sequence) return current;
  const saved = await store.advance(
    {
      accountId: input.accountId,
      stream: input.stream,
      sequence: input.sequence,
      eventId: input.eventId,
      updatedAt: input.now.toISOString(),
      version: current ? current.version + 1 : 1,
    },
    current?.version,
  );
  if (!saved) {
    const winner = await store.find(input.accountId, input.stream);
    if (winner && winner.sequence >= input.sequence) return winner;
    throw new Error('stale_notification_read_state');
  }
  return saved;
}

export class NotificationReadService {
  constructor(
    private readonly store: NotificationReadStore,
    private readonly authorization: NotificationReadAuthorization,
    private publisher?: NotificationReadPublisher,
  ) {}

  setPublisher(publisher: NotificationReadPublisher): void {
    this.publisher = publisher;
  }

  async get(accountId: string, stream: string) {
    this.validateStream(stream);
    if (!(await this.authorization.mayAccess(accountId, stream)))
      throw new Error('notification_read_state_not_found');
    return this.store.find(accountId, stream);
  }

  async advance(input: {
    accountId: string;
    stream: string;
    sequence: number;
    eventId: string;
    now: Date;
  }): Promise<NotificationReadState> {
    this.validateStream(input.stream);
    const state = await this.store.transaction(async (store) => {
      if (!(await this.authorization.mayAccess(input.accountId, input.stream)))
        throw new Error('notification_read_state_not_found');
      return advanceNotificationReadState(store, input);
    });
    // Durable state is authoritative. Fan-out is a latency optimization; a
    // failed publisher is recovered by GET/reconnect without rolling state back.
    await this.publisher?.publish(state).catch(() => undefined);
    return state;
  }

  private validateStream(stream: string): void {
    if (
      stream !== 'notifications' &&
      !/^space:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        stream,
      )
    )
      throw new Error('invalid_notification_read_state');
  }
}
