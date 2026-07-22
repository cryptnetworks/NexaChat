export type RetentionScope = 'instance' | 'community' | 'space';

export interface RetentionPolicy {
  scope: RetentionScope;
  scopeId: string;
  retainDays: number;
  tombstoneDays: number;
  updatedAt: string;
  version: number;
}

export interface RetentionCandidate {
  messageId: string;
  spaceId: string;
  communityId: string;
  createdAt: string;
  deletedAt: string | null;
  legalHold: boolean;
}

export interface RetentionBatchResult {
  scanned: number;
  eligible: number;
  deleted: number;
  held: number;
  failed: number;
  dryRun: boolean;
  checkpoint: string | null;
}

export interface RetentionStore {
  findPolicy(
    scope: RetentionScope,
    scopeId: string,
  ): Promise<RetentionPolicy | undefined>;
  savePolicy(
    policy: RetentionPolicy,
    expectedVersion?: number,
  ): Promise<RetentionPolicy | undefined>;
  listCandidates(input: {
    before: string;
    cursor?: string;
    limit: number;
  }): Promise<{ items: RetentionCandidate[]; nextCursor: string | null }>;
  isHeld(messageId: string): Promise<boolean>;
  purgeMessageGraph(messageId: string, tombstoneOnly: boolean): Promise<void>;
  saveCheckpoint(workerId: string, cursor: string | null): Promise<void>;
  getCheckpoint(workerId: string): Promise<string | null>;
}

const DEFAULT_RETAIN_DAYS = 365;
const DEFAULT_TOMBSTONE_DAYS = 30;

function validatePolicy(policy: RetentionPolicy): void {
  if (
    !Number.isInteger(policy.retainDays) ||
    policy.retainDays < 1 ||
    policy.retainDays > 3650 ||
    !Number.isInteger(policy.tombstoneDays) ||
    policy.tombstoneDays < 1 ||
    policy.tombstoneDays > 3650 ||
    policy.version < 1
  )
    throw new Error('invalid_retention_policy');
}

export async function resolveRetentionPolicy(
  store: RetentionStore,
  communityId: string,
  spaceId: string,
): Promise<RetentionPolicy> {
  const policy = (await store.findPolicy('space', spaceId)) ??
    (await store.findPolicy('community', communityId)) ??
    (await store.findPolicy('instance', 'default')) ?? {
      scope: 'instance' as const,
      scopeId: 'default',
      retainDays: DEFAULT_RETAIN_DAYS,
      tombstoneDays: DEFAULT_TOMBSTONE_DAYS,
      updatedAt: new Date(0).toISOString(),
      version: 1,
    };
  validatePolicy(policy);
  return policy;
}

export async function updateRetentionPolicy(
  store: RetentionStore,
  policy: RetentionPolicy,
  expectedVersion?: number,
): Promise<RetentionPolicy> {
  validatePolicy(policy);
  const saved = await store.savePolicy(policy, expectedVersion);
  if (!saved) throw new Error('stale_retention_policy');
  return saved;
}

/**
 * Processes one bounded batch. Callers schedule repeated invocations. The saved
 * cursor makes interruption and retry safe; purgeMessageGraph must atomically
 * remove bodies, edit history, reactions, and attachments while retaining the
 * stable message tombstone required by replies and unread cursors.
 */
export async function runRetentionBatch(
  store: RetentionStore,
  input: {
    workerId: string;
    now: Date;
    limit?: number;
    dryRun?: boolean;
  },
): Promise<RetentionBatchResult> {
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error('invalid_retention_batch');
  const cursor = (await store.getCheckpoint(input.workerId)) ?? undefined;
  // One day is the shortest valid policy. This avoids a full-history scan
  // without missing records governed by policies shorter than the default.
  const oldestPossible = new Date(
    input.now.getTime() - 86_400_000,
  ).toISOString();
  const page = await store.listCandidates({
    before: oldestPossible,
    ...(cursor ? { cursor } : {}),
    limit,
  });
  const result: RetentionBatchResult = {
    scanned: page.items.length,
    eligible: 0,
    deleted: 0,
    held: 0,
    failed: 0,
    dryRun: input.dryRun ?? false,
    checkpoint: page.nextCursor,
  };
  for (const candidate of page.items) {
    const policy = await resolveRetentionPolicy(
      store,
      candidate.communityId,
      candidate.spaceId,
    );
    const ageDays = Math.floor(
      (input.now.getTime() - new Date(candidate.createdAt).getTime()) /
        86_400_000,
    );
    if (ageDays < policy.retainDays) continue;
    result.eligible += 1;
    if (candidate.legalHold || (await store.isHeld(candidate.messageId))) {
      result.held += 1;
      continue;
    }
    if (result.dryRun) continue;
    try {
      const tombstoneAge = candidate.deletedAt
        ? Math.floor(
            (input.now.getTime() - new Date(candidate.deletedAt).getTime()) /
              86_400_000,
          )
        : 0;
      await store.purgeMessageGraph(
        candidate.messageId,
        !candidate.deletedAt || tombstoneAge < policy.tombstoneDays,
      );
      result.deleted += 1;
    } catch {
      result.failed += 1;
    }
  }
  if (!result.dryRun && result.failed === 0)
    await store.saveCheckpoint(input.workerId, page.nextCursor);
  return result;
}
