import { describe, expect, it } from 'vitest';
import {
  DirectRequestService,
  type DirectPrivacySetting,
  type DirectRequest,
  type DirectRequestStore,
} from '../src/direct-requests.js';

class Store implements DirectRequestStore {
  settings = new Map<string, DirectPrivacySetting>();
  requests = new Map<string, DirectRequest>();
  mutual = true;
  blocks = new Set<string>();
  reports: string[] = [];
  /* eslint-disable @typescript-eslint/require-await -- storage-port parity */
  setting = async (id: string) => this.settings.get(id);
  saveSetting = async (value: DirectPrivacySetting, expected?: number) => {
    const current = this.settings.get(value.accountId);
    if (
      (current && current.version !== expected) ||
      (!current && expected !== undefined)
    )
      return undefined;
    this.settings.set(value.accountId, value);
    return value;
  };
  find = async (id: string) => this.requests.get(id);
  findByIdempotencyKey = async (actor: string, key: string) =>
    [...this.requests.values()].find(
      (value) => value.requesterId === actor && value.idempotencyKey === key,
    );
  findActivePair = async (left: string, right: string, now: string) =>
    [...this.requests.values()].find(
      (value) =>
        ((value.requesterId === left && value.recipientId === right) ||
          (value.requesterId === right && value.recipientId === left)) &&
        ['pending', 'accepted'].includes(value.status) &&
        value.expiresAt > now,
    );
  countSince = async (actor: string, since: string) =>
    [...this.requests.values()].filter(
      (value) => value.requesterId === actor && value.createdAt >= since,
    ).length;
  hasMutualCommunity = async () => this.mutual;
  isBlocked = async (left: string, right: string) =>
    this.blocks.has(`${left}:${right}`) || this.blocks.has(`${right}:${left}`);
  create = async (value: DirectRequest) => (
    this.requests.set(value.id, value),
    value
  );
  update = async (
    id: string,
    version: number,
    patch: Partial<DirectRequest>,
  ) => {
    const current = this.requests.get(id);
    if (!current || current.version !== version) return undefined;
    const next = { ...current, ...patch, version: version + 1 };
    this.requests.set(id, next);
    return next;
  };
  block = async (blocker: string, blocked: string) =>
    void this.blocks.add(`${blocker}:${blocked}`);
  reportAbuse = async (_reporter: string, requestId: string) => (
    this.reports.push(requestId),
    `report:${requestId}`
  );
  /* eslint-enable @typescript-eslint/require-await */
  transaction = <T>(
    work: (store: DirectRequestStore) => Promise<T>,
  ): Promise<T> => work(this);
}

const setup = () => {
  const store = new Store();
  /* eslint-disable @typescript-eslint/require-await -- adapter parity */
  const service = new DirectRequestService(store, {
    assertAccountActive: async (id) => {
      if (id === 'suspended') throw new Error('inactive');
    },
  });
  /* eslint-enable @typescript-eslint/require-await */
  return { store, service };
};

describe('direct request controls', () => {
  it('enforces privacy and mutual-community settings without enumeration', async () => {
    const { store, service } = setup();
    const now = new Date('2026-01-01');
    await service.updateSetting(
      'bob',
      { preference: 'deny', requireMutualCommunity: false },
      now,
    );
    await expect(
      service.request({
        requesterId: 'alice',
        recipientId: 'bob',
        idempotencyKey: 'request-key-01',
        now,
      }),
    ).rejects.toThrow('direct_unavailable');
    await service.updateSetting(
      'bob',
      {
        preference: 'request',
        requireMutualCommunity: true,
        expectedVersion: 1,
      },
      now,
    );
    store.mutual = false;
    await expect(
      service.request({
        requesterId: 'alice',
        recipientId: 'bob',
        idempotencyKey: 'request-key-02',
        now,
      }),
    ).rejects.toThrow('direct_unavailable');
  });

  it('handles duplicates, ignore privacy, allow, block, and abuse reports', async () => {
    const { store, service } = setup();
    const now = new Date('2026-01-01');
    const request = await service.request({
      requesterId: 'alice',
      recipientId: 'bob',
      idempotencyKey: 'request-key-03',
      now,
    });
    expect(
      (
        await service.request({
          requesterId: 'alice',
          recipientId: 'bob',
          idempotencyKey: 'request-key-03',
          now,
        })
      ).id,
    ).toBe(request.id);
    await service.respond({
      actorId: 'bob',
      requestId: request.id,
      action: 'ignore',
      expectedVersion: 1,
      now,
    });
    expect(
      (await service.getForRequester('alice', request.id, now)).status,
    ).toBe('pending');
    const second = await service.request({
      requesterId: 'mallory',
      recipientId: 'bob',
      idempotencyKey: 'request-key-04',
      now,
    });
    await service.respond({
      actorId: 'bob',
      requestId: second.id,
      action: 'block',
      expectedVersion: 1,
      now,
    });
    await expect(
      service.request({
        requesterId: 'mallory',
        recipientId: 'bob',
        idempotencyKey: 'request-key-05',
        now,
      }),
    ).rejects.toThrow('direct_unavailable');
    expect(
      await service.reportAbuse('bob', second.id, 'spam', 'corr', now),
    ).toBe(`report:${second.id}`);
    expect(store.reports).toEqual([second.id]);
  });

  it('expires pending requests and prevents stale responses', async () => {
    const { service } = setup();
    const now = new Date('2026-01-01');
    const request = await service.request({
      requesterId: 'alice',
      recipientId: 'bob',
      idempotencyKey: 'request-key-06',
      now,
    });
    const late = new Date('2026-02-01');
    expect(
      (await service.getForRequester('alice', request.id, late)).status,
    ).toBe('expired');
    expect(
      (
        await service.respond({
          actorId: 'bob',
          requestId: request.id,
          action: 'allow',
          expectedVersion: 1,
          now: late,
        })
      ).status,
    ).toBe('expired');
  });
});
