import { createHash, randomUUID } from 'node:crypto';

export type DirectRequestPreference = 'allow' | 'request' | 'deny';
export interface DirectPrivacySetting {
  accountId: string;
  preference: DirectRequestPreference;
  requireMutualCommunity: boolean;
  version: number;
  updatedAt: string;
}

export type DirectRequestStatus =
  'pending' | 'accepted' | 'denied' | 'ignored' | 'blocked' | 'expired';

export interface DirectRequest {
  id: string;
  requesterId: string;
  recipientId: string;
  status: DirectRequestStatus;
  idempotencyKey: string;
  requestFingerprint: string;
  createdAt: string;
  expiresAt: string;
  respondedAt: string | null;
  version: number;
}

export interface DirectRequestStore {
  setting(accountId: string): Promise<DirectPrivacySetting | undefined>;
  saveSetting(
    value: DirectPrivacySetting,
    expectedVersion?: number,
  ): Promise<DirectPrivacySetting | undefined>;
  find(id: string): Promise<DirectRequest | undefined>;
  findByIdempotencyKey(
    requesterId: string,
    key: string,
  ): Promise<DirectRequest | undefined>;
  findActivePair(
    requesterId: string,
    recipientId: string,
    now: string,
  ): Promise<DirectRequest | undefined>;
  countSince(requesterId: string, since: string): Promise<number>;
  hasMutualCommunity(leftId: string, rightId: string): Promise<boolean>;
  isBlocked(leftId: string, rightId: string): Promise<boolean>;
  create(value: DirectRequest): Promise<DirectRequest>;
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<DirectRequest>,
  ): Promise<DirectRequest | undefined>;
  block(
    blockerId: string,
    blockedId: string,
    requestId: string,
    now: string,
  ): Promise<void>;
  reportAbuse(
    reporterId: string,
    requestId: string,
    category: string,
    correlationId: string,
    now: string,
  ): Promise<string>;
  transaction<T>(work: (store: DirectRequestStore) => Promise<T>): Promise<T>;
}

export interface DirectRequestAuthorization {
  assertAccountActive(accountId: string): Promise<void>;
}

const defaultSetting = (accountId: string): DirectPrivacySetting => ({
  accountId,
  preference: 'request',
  requireMutualCommunity: true,
  version: 1,
  updatedAt: new Date(0).toISOString(),
});

function key(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized))
    throw new Error('invalid_idempotency_key');
  return normalized;
}

export class DirectRequestService {
  constructor(
    private readonly store: DirectRequestStore,
    private readonly authorization: DirectRequestAuthorization,
  ) {}

  async updateSetting(
    actorId: string,
    input: {
      preference: DirectRequestPreference;
      requireMutualCommunity: boolean;
      expectedVersion?: number;
    },
    now: Date,
  ): Promise<DirectPrivacySetting> {
    await this.active(actorId);
    const current = await this.store.setting(actorId);
    if (current && input.expectedVersion === undefined)
      throw new Error('stale_direct_setting');
    const saved = await this.store.saveSetting(
      {
        accountId: actorId,
        preference: input.preference,
        requireMutualCommunity: input.requireMutualCommunity,
        version: current ? current.version + 1 : 1,
        updatedAt: now.toISOString(),
      },
      input.expectedVersion,
    );
    if (!saved) throw new Error('stale_direct_setting');
    return saved;
  }

  async request(input: {
    requesterId: string;
    recipientId: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<DirectRequest> {
    if (!input.requesterId || input.requesterId === input.recipientId)
      throw new Error('direct_unavailable');
    const normalizedKey = key(input.idempotencyKey);
    await this.active(input.requesterId);
    await this.active(input.recipientId);
    if (await this.store.isBlocked(input.requesterId, input.recipientId))
      throw new Error('direct_unavailable');
    const setting =
      (await this.store.setting(input.recipientId)) ??
      defaultSetting(input.recipientId);
    if (setting.preference === 'deny') throw new Error('direct_unavailable');
    if (
      setting.requireMutualCommunity &&
      !(await this.store.hasMutualCommunity(
        input.requesterId,
        input.recipientId,
      ))
    )
      throw new Error('direct_unavailable');
    const fingerprint = createHash('sha256')
      .update(`${input.requesterId}:${input.recipientId}`)
      .digest('hex');
    const duplicate = await this.store.findByIdempotencyKey(
      input.requesterId,
      normalizedKey,
    );
    if (duplicate) {
      if (duplicate.requestFingerprint !== fingerprint)
        throw new Error('idempotency_conflict');
      return this.requesterView(duplicate, input.now);
    }
    const active = await this.store.findActivePair(
      input.requesterId,
      input.recipientId,
      input.now.toISOString(),
    );
    if (active) return this.requesterView(active, input.now);
    if (
      (await this.store.countSince(
        input.requesterId,
        new Date(input.now.getTime() - 86_400_000).toISOString(),
      )) >= 10
    )
      throw new Error('direct_request_rate_limited');
    return this.store.transaction(async (store) => {
      await this.active(input.requesterId);
      await this.active(input.recipientId);
      if (await store.isBlocked(input.requesterId, input.recipientId))
        throw new Error('direct_unavailable');
      const retried = await store.findActivePair(
        input.requesterId,
        input.recipientId,
        input.now.toISOString(),
      );
      if (retried) return this.requesterView(retried, input.now);
      return store.create({
        id: randomUUID(),
        requesterId: input.requesterId,
        recipientId: input.recipientId,
        status: setting.preference === 'allow' ? 'accepted' : 'pending',
        idempotencyKey: normalizedKey,
        requestFingerprint: fingerprint,
        createdAt: input.now.toISOString(),
        expiresAt: new Date(
          input.now.getTime() + 14 * 86_400_000,
        ).toISOString(),
        respondedAt:
          setting.preference === 'allow' ? input.now.toISOString() : null,
        version: 1,
      });
    });
  }

  async respond(input: {
    actorId: string;
    requestId: string;
    action: 'allow' | 'deny' | 'ignore' | 'block';
    expectedVersion: number;
    now: Date;
  }): Promise<DirectRequest> {
    return this.store.transaction(async (store) => {
      await this.active(input.actorId);
      const request = await store.find(input.requestId);
      if (!request || request.recipientId !== input.actorId)
        throw new Error('direct_unavailable');
      if (request.status !== 'pending') return request;
      if (input.now >= new Date(request.expiresAt)) {
        const expired = await store.update(request.id, input.expectedVersion, {
          status: 'expired',
        });
        if (!expired) throw new Error('stale_direct_request');
        return expired;
      }
      const status = {
        allow: 'accepted',
        deny: 'denied',
        ignore: 'ignored',
        block: 'blocked',
      }[input.action] as DirectRequestStatus;
      if (input.action === 'block')
        await store.block(
          input.actorId,
          request.requesterId,
          request.id,
          input.now.toISOString(),
        );
      const updated = await store.update(request.id, input.expectedVersion, {
        status,
        respondedAt: input.now.toISOString(),
      });
      if (!updated) throw new Error('stale_direct_request');
      return updated;
    });
  }

  async getForRequester(
    actorId: string,
    requestId: string,
    now: Date,
  ): Promise<DirectRequest> {
    const request = await this.store.find(requestId);
    if (!request || request.requesterId !== actorId)
      throw new Error('direct_unavailable');
    return this.requesterView(request, now);
  }

  async reportAbuse(
    actorId: string,
    requestId: string,
    category: 'spam' | 'harassment',
    correlationId: string,
    now: Date,
  ): Promise<string> {
    const request = await this.store.find(requestId);
    if (
      !request ||
      ![request.requesterId, request.recipientId].includes(actorId)
    )
      throw new Error('direct_unavailable');
    return this.store.reportAbuse(
      actorId,
      requestId,
      category,
      correlationId,
      now.toISOString(),
    );
  }

  async assertCanStart(
    actorId: string,
    otherId: string,
    now: Date,
  ): Promise<void> {
    await this.active(actorId);
    await this.active(otherId);
    if (await this.store.isBlocked(actorId, otherId))
      throw new Error('direct_unavailable');
    const accepted = await this.store.findActivePair(
      actorId,
      otherId,
      now.toISOString(),
    );
    const setting =
      (await this.store.setting(otherId)) ?? defaultSetting(otherId);
    if (accepted?.status !== 'accepted' && setting.preference !== 'allow')
      throw new Error('direct_unavailable');
  }

  private requesterView(request: DirectRequest, now: Date): DirectRequest {
    if (now >= new Date(request.expiresAt))
      return { ...request, status: 'expired' };
    // Ignoring is deliberately indistinguishable from a still-pending request.
    return request.status === 'ignored'
      ? { ...request, status: 'pending', respondedAt: null }
      : request;
  }

  private async active(accountId: string): Promise<void> {
    try {
      await this.authorization.assertAccountActive(accountId);
    } catch {
      throw new Error('direct_unavailable');
    }
  }
}
