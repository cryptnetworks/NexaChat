import { describe, expect, it } from 'vitest';
import {
  FixedWindowRateLimiter,
  RecoveryError,
  RecoveryService,
  type AuthSession,
  type RecoveryAccount,
  type RecoveryChallenge,
  type RecoveryMethod,
  type RecoverySecurityEvent,
  type RecoveryStore,
} from '../src/index.js';

class Clock {
  value = new Date('2026-01-01T00:00:00.000Z');
  now() {
    return this.value;
  }
}

class Store implements RecoveryStore {
  accounts = new Map<string, RecoveryAccount>();
  sessions = new Map<string, AuthSession>();
  challenges = new Map<string, RecoveryChallenge>();
  methods = new Map<string, RecoveryMethod>();
  events: RecoverySecurityEvent[] = [];
  private tail = Promise.resolve();

  findAccountByNormalizedUsername(username: string) {
    return Promise.resolve(
      [...this.accounts.values()].find(
        (account) => account.normalizedUsername === username,
      ),
    );
  }
  findAccountById(id: string) {
    return Promise.resolve(this.accounts.get(id));
  }
  createChallenge(challenge: RecoveryChallenge) {
    this.challenges.set(challenge.id, challenge);
    return Promise.resolve();
  }
  findChallengeByTokenHash(tokenHash: string) {
    return Promise.resolve(
      [...this.challenges.values()].find(
        (challenge) => challenge.tokenHash === tokenHash,
      ),
    );
  }
  consumeChallenge(id: string, expectedVersion: number, now: string) {
    const value = this.challenges.get(id);
    if (
      !value ||
      value.version !== expectedVersion ||
      value.state !== 'pending' ||
      value.expiresAt <= now ||
      value.attempts >= value.maxAttempts
    )
      return Promise.resolve(false);
    this.challenges.set(id, {
      ...value,
      state: 'used',
      usedAt: now,
      attempts: value.attempts + 1,
      version: value.version + 1,
    });
    return Promise.resolve(true);
  }
  updateChallengeState(
    id: string,
    expectedVersion: number,
    state: 'expired' | 'invalidated',
  ) {
    const value = this.challenges.get(id);
    if (
      !value ||
      value.version !== expectedVersion ||
      value.state !== 'pending'
    )
      return Promise.resolve(false);
    this.challenges.set(id, { ...value, state, version: value.version + 1 });
    return Promise.resolve(true);
  }
  changeCredentials(
    accountId: string,
    expectedCredentialVersion: number,
    passwordHash: string,
  ) {
    const value = this.accounts.get(accountId);
    if (
      !value ||
      value.credentialVersion !== expectedCredentialVersion ||
      value.status !== 'active'
    )
      return Promise.resolve(undefined);
    const updated = {
      ...value,
      passwordHash,
      credentialVersion: value.credentialVersion + 1,
      recoveryEpoch: value.recoveryEpoch + 1,
    };
    this.accounts.set(accountId, updated);
    return Promise.resolve(updated);
  }
  revokeAllSessions(accountId: string, revokedAt: string) {
    let count = 0;
    for (const [id, value] of this.sessions) {
      if (value.accountId === accountId && !value.revokedAt) {
        this.sessions.set(id, { ...value, revokedAt });
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
  createMethod(method: RecoveryMethod) {
    this.methods.set(method.id, method);
    return Promise.resolve(method);
  }
  findMethod(accountId: string, methodId: string) {
    const method = this.methods.get(methodId);
    return Promise.resolve(
      method?.accountId === accountId ? method : undefined,
    );
  }
  listMethods(accountId: string) {
    return Promise.resolve(
      [...this.methods.values()].filter(
        (method) => method.accountId === accountId,
      ),
    );
  }
  verifyMethod(
    accountId: string,
    methodId: string,
    expectedVersion: number,
    verifiedAt: string,
  ) {
    const value = this.methods.get(methodId);
    if (
      !value ||
      value.accountId !== accountId ||
      value.version !== expectedVersion ||
      value.state !== 'pending'
    )
      return Promise.resolve(undefined);
    const verified = {
      ...value,
      state: 'verified' as const,
      lastVerifiedAt: verifiedAt,
      version: value.version + 1,
    };
    this.methods.set(methodId, verified);
    return Promise.resolve(verified);
  }
  revokeMethod(accountId: string, methodId: string, expectedVersion: number) {
    const value = this.methods.get(methodId);
    if (
      !value ||
      value.accountId !== accountId ||
      value.version !== expectedVersion ||
      value.state === 'revoked'
    )
      return Promise.resolve(undefined);
    const revoked = {
      ...value,
      state: 'revoked' as const,
      version: value.version + 1,
    };
    this.methods.set(methodId, revoked);
    return Promise.resolve(revoked);
  }
  updateRecoveryLock(accountId: string, locked: boolean) {
    const value = this.accounts.get(accountId);
    if (!value) return Promise.resolve(false);
    this.accounts.set(accountId, { ...value, recoveryLocked: locked });
    return Promise.resolve(true);
  }
  invalidateChallenges(accountId: string, epoch: number) {
    let count = 0;
    for (const [id, value] of this.challenges) {
      if (
        value.accountId === accountId &&
        value.state === 'pending' &&
        value.epoch < epoch
      ) {
        this.challenges.set(id, {
          ...value,
          state: 'invalidated',
          version: value.version + 1,
        });
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
  recordSecurityEvent(event: RecoverySecurityEvent) {
    this.events.push(event);
    return Promise.resolve();
  }
  async transaction<T>(work: (store: RecoveryStore) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await work(this);
    } finally {
      release();
    }
  }
}

const account = (): RecoveryAccount => ({
  id: '00000000-0000-4000-8000-000000000001',
  username: 'recoverable',
  normalizedUsername: 'recoverable',
  displayName: 'Recoverable',
  passwordHash: 'old-hash',
  status: 'active',
  credentialVersion: 1,
  profileVersion: 1,
  avatar: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  recoveryEpoch: 1,
  recoveryLocked: false,
});

function fixture() {
  const store = new Store();
  store.accounts.set(account().id, account());
  const clock = new Clock();
  const service = new RecoveryService(
    store,
    {
      hash: (value) => Promise.resolve(`hash:${value}`),
      verify: () => Promise.resolve(true),
      needsRehash: () => false,
      dummyHash: () => 'dummy',
    },
    new FixedWindowRateLimiter(100, 60_000),
    clock,
    {},
    () => Buffer.from('12345678901234567890123456789012'),
  );
  return { store, clock, service };
}

describe('RecoveryService', () => {
  it('uses generic request outcomes and issues 256-bit tokens only for eligible accounts', async () => {
    const { service } = fixture();
    await expect(
      service.requestRecovery({ username: 'unknown', source: 'test' }),
    ).resolves.toEqual({ accepted: true });
    const result = await service.requestRecovery({
      username: 'recoverable',
      source: 'test',
    });
    expect(result.accepted).toBe(true);
    expect(result.token).toHaveLength(43);
  });

  it('allows one completion winner and revokes every session', async () => {
    const { service, store } = fixture();
    const issued = await service.requestRecovery({
      username: 'recoverable',
      source: 'test',
    });
    if (!issued.token) throw new Error('test token missing');
    store.sessions.set('session', {
      id: 'session',
      publicHandle: 'sess_AAAAAAAAAAAAAAAA',
      accountId: account().id,
      tokenHash: 'hash',
      credentialVersion: 1,
      createdAt: account().createdAt,
      lastSeenAt: account().createdAt,
      recentAuthAt: account().createdAt,
      expiresAt: '2027-01-01T00:00:00.000Z',
      idleExpiresAt: '2027-01-01T00:00:00.000Z',
      revokedAt: null,
    });
    const results = await Promise.allSettled([
      service.completeRecovery({
        token: issued.token,
        newPassword: 'new password 1',
        correlationId: '00000000-0000-4000-8000-000000000010',
      }),
      service.completeRecovery({
        token: issued.token,
        newPassword: 'new password 2',
        correlationId: '00000000-0000-4000-8000-000000000011',
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(store.accounts.get(account().id)?.recoveryEpoch).toBe(2);
    expect(store.sessions.get('session')?.revokedAt).not.toBeNull();
    await expect(
      service.completeRecovery({
        token: issued.token,
        newPassword: 'new password 3',
        correlationId: '00000000-0000-4000-8000-000000000012',
      }),
    ).rejects.toBeInstanceOf(RecoveryError);
  });

  it('keeps method enrollment pending until the matching token verifies', async () => {
    const { service, store } = fixture();
    const started = await service.startMethod({
      accountId: account().id,
      kind: 'email',
      destinationCiphertext: 'encrypted-ref',
      destinationDigest: 'a'.repeat(64),
    });
    await expect(
      service.verifyMethod(
        account().id,
        started.token,
        '00000000-0000-4000-8000-000000000099',
      ),
    ).rejects.toBeInstanceOf(RecoveryError);
    const verified = await service.verifyMethod(
      account().id,
      started.token,
      started.method.id,
    );
    expect(verified.state).toBe('verified');
    expect(store.events.map((event) => event.action)).toContain(
      'account.recovery.method.verify',
    );
  });
});
