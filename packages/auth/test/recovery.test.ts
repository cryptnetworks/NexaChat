import { describe, expect, it } from 'vitest';
import {
  FixedWindowRateLimiter,
  DistributedRecoveryRateLimiter,
  RecoveryError,
  RecoveryService,
  type AuthSession,
  type RecoveryAccount,
  type RecoveryChallenge,
  type RecoveryIdempotencyRecord,
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
  idempotency = new Map<string, RecoveryIdempotencyRecord>();
  operatorIds = new Set<string>();
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
  findRecoveryIdempotency(
    scope: RecoveryIdempotencyRecord['scope'],
    idempotencyKey: string,
  ) {
    return Promise.resolve(this.idempotency.get(`${scope}:${idempotencyKey}`));
  }
  createRecoveryIdempotency(record: RecoveryIdempotencyRecord) {
    const key = `${record.scope}:${record.idempotencyKey}`;
    if (this.idempotency.has(key)) return Promise.resolve(false);
    this.idempotency.set(key, record);
    return Promise.resolve(true);
  }
  completeRecoveryIdempotency(
    scope: RecoveryIdempotencyRecord['scope'],
    idempotencyKey: string,
    expectedVersion: number,
    challengeId: string | null,
    completedAt: string,
  ) {
    const key = `${scope}:${idempotencyKey}`;
    const value = this.idempotency.get(key);
    if (
      !value ||
      value.version !== expectedVersion ||
      value.state !== 'pending'
    )
      return Promise.resolve(false);
    this.idempotency.set(key, {
      ...value,
      state: 'succeeded',
      challengeId,
      completedAt,
      version: value.version + 1,
    });
    return Promise.resolve(true);
  }
  assertRecoveryOperator(actorId: string) {
    return Promise.resolve(this.operatorIds.has(actorId));
  }
  revokeAllMethods(accountId: string) {
    let count = 0;
    for (const [id, value] of this.methods) {
      if (value.accountId !== accountId || value.state === 'revoked') continue;
      this.methods.set(id, {
        ...value,
        state: 'revoked',
        destinationCiphertext: '',
        version: value.version + 1,
      });
      count += 1;
    }
    return Promise.resolve(count);
  }
  expireChallenges(now: string, limit: number) {
    let count = 0;
    for (const [id, value] of this.challenges) {
      if (count >= limit || value.state !== 'pending' || value.expiresAt > now)
        continue;
      this.challenges.set(id, {
        ...value,
        state: 'expired',
        version: value.version + 1,
      });
      count += 1;
    }
    return Promise.resolve(count);
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

  it('keeps unknown, suspended, and locked requests shape-identical', async () => {
    const { service, store } = fixture();
    const suspended = account();
    suspended.id = '00000000-0000-4000-8000-000000000002';
    suspended.username = 'suspended';
    suspended.normalizedUsername = 'suspended';
    suspended.status = 'suspended';
    const locked = account();
    locked.id = '00000000-0000-4000-8000-000000000003';
    locked.username = 'locked';
    locked.normalizedUsername = 'locked';
    locked.recoveryLocked = true;
    store.accounts.set(suspended.id, suspended);
    store.accounts.set(locked.id, locked);
    const outcomes = await Promise.all(
      ['missing', 'suspended', 'locked'].map((username, index) =>
        service.requestRecovery({
          username,
          source: 'enumeration-test',
          idempotencyKey: `enumeration-request-${String(index)}`,
        }),
      ),
    );
    expect(outcomes).toEqual([
      { accepted: true },
      { accepted: true },
      { accepted: true },
    ]);
  });

  it('hashes distributed flood keys and bounds the local bucket count', async () => {
    const keys: string[] = [];
    const limiter = new DistributedRecoveryRateLimiter(
      {
        increment: (key) => {
          keys.push(key);
          return Promise.resolve({ count: 1 });
        },
      },
      10,
      1_000,
      2,
    );
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        limiter.consume(
          [`source-${String(index)}`, 'private-identifier'],
          new Date(),
        ),
      ),
    );
    expect(keys).toHaveLength(20);
    expect(keys.every((key) => /^recovery:[0-9a-f]{64}$/u.test(key))).toBe(
      true,
    );
    expect(keys.some((key) => key.includes('private-identifier'))).toBe(false);
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

  it('persists restart-safe idempotency outcomes and rejects key reuse conflicts', async () => {
    const { service, store } = fixture();
    const first = await service.requestRecovery({
      username: 'recoverable',
      source: 'test',
      idempotencyKey: 'recovery-request-1',
    });
    const replay = await service.requestRecovery({
      username: 'recoverable',
      source: 'different-source',
      idempotencyKey: 'recovery-request-1',
    });
    expect(first.token).toHaveLength(43);
    expect(replay.token).toBeUndefined();
    expect(store.challenges.size).toBe(1);

    if (!first.token) throw new Error('test token missing');
    await service.completeRecovery({
      token: first.token,
      newPassword: 'new password 1',
      correlationId: '00000000-0000-4000-8000-000000000013',
      idempotencyKey: 'recovery-complete-1',
    });
    await expect(
      service.completeRecovery({
        token: first.token,
        newPassword: 'new password 1',
        correlationId: '00000000-0000-4000-8000-000000000014',
        idempotencyKey: 'recovery-complete-1',
      }),
    ).resolves.toBeUndefined();
    await expect(
      service.completeRecovery({
        token: first.token,
        newPassword: 'different password',
        correlationId: '00000000-0000-4000-8000-000000000015',
        idempotencyKey: 'recovery-complete-1',
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

  it('serializes replacement against the verified method and binds its purpose', async () => {
    const { service, store } = fixture();
    const oldMethod: RecoveryMethod = {
      id: '00000000-0000-4000-8000-000000000098',
      accountId: account().id,
      kind: 'email',
      destinationCiphertext: 'old-encrypted-ref',
      destinationDigest: 'c'.repeat(64),
      state: 'verified',
      createdAt: '2025-12-31T00:00:00.000Z',
      lastVerifiedAt: '2025-12-31T00:00:00.000Z',
      version: 2,
    };
    store.methods.set(oldMethod.id, oldMethod);
    const result = await service.replaceMethod({
      accountId: account().id,
      oldMethodId: oldMethod.id,
      kind: 'phone',
      destinationCiphertext: 'new-encrypted-ref',
      destinationDigest: 'd'.repeat(64),
    });
    expect(store.methods.get(oldMethod.id)?.state).toBe('verified');
    expect(
      [...store.challenges.values()].find(
        (challenge) => challenge.methodId === result.method.id,
      )?.purpose,
    ).toBe('method_replacement');
  });

  it('requires a provisioned recent-auth operator for bounded controls', async () => {
    const { service, store, clock } = fixture();
    store.operatorIds.add(account().id);
    const started = await service.startMethod({
      accountId: account().id,
      kind: 'email',
      destinationCiphertext: 'encrypted-ref',
      destinationDigest: 'b'.repeat(64),
    });
    await expect(
      service.operatorLock({
        actorId: account().id,
        accountId: account().id,
        locked: true,
        authenticatedAt: '2025-12-31T23:00:00.000Z',
        correlationId: '00000000-0000-4000-8000-000000000016',
      }),
    ).rejects.toBeInstanceOf(RecoveryError);
    await service.operatorLock({
      actorId: account().id,
      accountId: account().id,
      locked: true,
      authenticatedAt: clock.now().toISOString(),
      correlationId: '00000000-0000-4000-8000-000000000017',
    });
    expect(store.accounts.get(account().id)?.recoveryLocked).toBe(true);
    expect(
      [...store.challenges.values()].some(
        (challenge) =>
          challenge.methodId === started.method.id &&
          challenge.state === 'pending',
      ),
    ).toBe(false);
    await expect(
      service.requestRecovery({
        username: account().username,
        source: 'test',
        idempotencyKey: 'operator-locked-request',
      }),
    ).resolves.toEqual({ accepted: true });
  });

  it('handles the expiry boundary and bounded cleanup deterministically', async () => {
    const { service, store, clock } = fixture();
    const issued = await service.requestRecovery({
      username: account().username,
      source: 'test',
      idempotencyKey: 'expiry-boundary-request',
    });
    if (!issued.token) throw new Error('test token missing');
    clock.value = new Date('2026-01-01T00:30:00.000Z');
    await expect(
      service.completeRecovery({
        token: issued.token,
        newPassword: 'expired password',
        correlationId: '00000000-0000-4000-8000-000000000018',
        idempotencyKey: 'expiry-boundary-complete',
      }),
    ).rejects.toBeInstanceOf(RecoveryError);
    await expect(service.expireChallenges(1)).resolves.toBe(1);
    expect([...store.challenges.values()][0]?.state).toBe('expired');
  });
});
