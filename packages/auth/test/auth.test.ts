import { describe, expect, it } from 'vitest';
import {
  AuthenticationService,
  FixedWindowRateLimiter,
  createArgon2idHasher,
  normalizeUsername,
  type AuthAccount,
  type AuthSession,
  type AuthStore,
  type PasswordHasher,
  type RateLimiter,
} from '../src/index.js';

const password = 'correct horse battery staple';

describe('AuthenticationService', () => {
  it('normalizes identifiers and handles duplicate and concurrent registration', async () => {
    const { service } = fixture();
    const first = await service.register(input('  ÁDA  '));
    expect(first.account.username).toBe('ÁDA');
    expect(normalizeUsername('  ÁDA  ')).toBe('áda');
    await expect(service.register(input('áda'))).rejects.toMatchObject({
      code: 'identifier_unavailable',
    });
    const race = fixture();
    const results = await Promise.allSettled([
      race.service.register(input('Racer')),
      race.service.register(input('racer')),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('returns uniform failures for unknown and incorrect credentials', async () => {
    const { service } = fixture();
    await service.register(input('known'));
    const unknown = service.login({
      username: 'unknown',
      password,
      source: 'one',
    });
    const incorrect = service.login({
      username: 'known',
      password: 'wrong password!',
      source: 'two',
    });
    await expect(unknown).rejects.toMatchObject({
      code: 'authentication_failed',
    });
    await expect(incorrect).rejects.toMatchObject({
      code: 'authentication_failed',
    });
  });

  it('normalizes profile updates and rejects collisions, stale writes, and suspended accounts', async () => {
    const { service, store } = fixture();
    const first = await service.register(input('ProfileOne'));
    await service.register(input('ProfileTwo'));
    const updated = await service.updateProfile(first.account.id, {
      username: '  Profile_One  ',
      displayName: '  Ada\t  Lovelace  ',
      expectedVersion: 1,
    });
    expect(updated).toMatchObject({
      username: 'Profile_One',
      displayName: 'Ada Lovelace',
      version: 2,
    });
    await expect(
      service.updateProfile(first.account.id, {
        username: 'profiletwo',
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: 'identifier_unavailable' });
    const race = await Promise.allSettled([
      service.updateProfile(first.account.id, {
        displayName: 'First writer',
        expectedVersion: 2,
      }),
      service.updateProfile(first.account.id, {
        displayName: 'Second writer',
        expectedVersion: 2,
      }),
    ]);
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(race.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'stale_write' },
    });
    const account = store.accounts.get(first.account.id);
    if (!account) throw new Error('test account missing');
    store.accounts.set(account.id, { ...account, status: 'suspended' });
    await expect(service.getProfile(account.id)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('rotates tokens, lists sessions, and revokes immediately and concurrently', async () => {
    const { service } = fixture();
    const registered = await service.register(input('sessions'));
    const loggedIn = await service.login({
      username: 'sessions',
      password,
      source: 'two',
    });
    expect(loggedIn.session.token).not.toBe(registered.session.token);
    expect(await service.listSessions(registered.account.id)).toHaveLength(2);
    const authenticated = await service.authenticate(loggedIn.session.token);
    await Promise.all([
      service.logout(authenticated.session.id),
      service.logout(authenticated.session.id),
    ]);
    await expect(
      service.authenticate(loggedIn.session.token),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    await service.logoutAll(registered.account.id);
    await expect(
      service.authenticate(registered.session.token),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('enforces malformed, absolute, idle, suspended, and credential-reset invalidation', async () => {
    const clock = new TestClock('2026-01-01T00:00:00.000Z');
    const { service, store } = fixture(clock, {
      absoluteSessionMs: 1000,
      idleSessionMs: 500,
    });
    const issued = await service.register(input('expiry'));
    await expect(service.authenticate('malformed')).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    clock.set('2026-01-01T00:00:00.500Z');
    await expect(
      service.authenticate(issued.session.token),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    const second = await service.login({
      username: 'expiry',
      password,
      source: 'two',
    });
    clock.set('2026-01-01T00:00:01.500Z');
    await expect(
      service.authenticate(second.session.token),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    clock.set('2026-01-01T00:00:00.600Z');
    const third = await service.login({
      username: 'expiry',
      password,
      source: 'three',
    });
    const account = store.accounts.get(issued.account.id);
    if (!account) throw new Error('test account missing');
    store.accounts.set(account.id, { ...account, status: 'suspended' });
    await expect(
      service.authenticate(third.session.token),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    store.accounts.set(account.id, { ...account, status: 'active' });
    await service.resetCredentials(account.id, 'a replacement password');
    await expect(
      service.authenticate(third.session.token),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('fails closed when rate limiting is exhausted or unavailable', async () => {
    const limited = fixture(
      undefined,
      undefined,
      new FixedWindowRateLimiter(1, 60_000),
    );
    await limited.service.register(input('limited'));
    await expect(
      limited.service.login({ username: 'limited', password, source: 'one' }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    const unavailable: RateLimiter = {
      consume: () => Promise.reject(new Error('down')),
    };
    await expect(
      fixture(undefined, undefined, unavailable).service.register(
        input('closed'),
      ),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('limits identifier guessing across different sources', async () => {
    const limited = fixture(
      undefined,
      undefined,
      new FixedWindowRateLimiter(2, 60_000),
    );
    await limited.service.register(input('target'));
    await expect(
      limited.service.login({
        username: 'target',
        password: 'wrong password!',
        source: 'two',
      }),
    ).rejects.toMatchObject({ code: 'authentication_failed' });
    await expect(
      limited.service.login({
        username: 'target',
        password: 'wrong password!',
        source: 'three',
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('hashes with Argon2id without plaintext and detects parameter changes', async () => {
    const parameters = {
      memoryKiB: 19_456,
      passes: 2,
      parallelism: 1,
      tagLength: 32,
      saltLength: 16,
    };
    const hasher = createArgon2idHasher(parameters);
    const encoded = await hasher.hash(password);
    expect(encoded).not.toContain(password);
    await expect(hasher.verify(password, encoded)).resolves.toBe(true);
    await expect(hasher.verify('incorrect credential', encoded)).resolves.toBe(
      false,
    );
    expect(hasher.needsRehash(encoded)).toBe(false);
    const upgraded = createArgon2idHasher({ ...parameters, passes: 3 });
    expect(upgraded.needsRehash(encoded)).toBe(true);
    await expect(upgraded.verify(password, encoded)).resolves.toBe(true);
    expect(() =>
      createArgon2idHasher({ ...parameters, memoryKiB: 1 }),
    ).toThrow();
  });
});

function input(username: string) {
  return { username, displayName: 'Ada', password, source: 'one' };
}

function fixture(
  clock = new TestClock('2026-01-01T00:00:00.000Z'),
  config = { absoluteSessionMs: 10_000, idleSessionMs: 5_000 },
  limiter: RateLimiter = new FixedWindowRateLimiter(20, 60_000),
) {
  const store = new MemoryAuthStore();
  /* eslint-disable @typescript-eslint/require-await -- deterministic test adapter */
  const hasher: PasswordHasher = {
    hash: async (value) => `hash:${value}`,
    verify: async (value, encoded) => encoded === `hash:${value}`,
    needsRehash: () => false,
    dummyHash: () => 'hash:impossible',
  };
  /* eslint-enable @typescript-eslint/require-await */
  let token = 0;
  const service = new AuthenticationService(
    store,
    hasher,
    limiter,
    clock,
    config,
    () => Buffer.alloc(32, ++token),
  );
  return { service, store };
}

class TestClock {
  constructor(private value: string) {}
  now() {
    return new Date(this.value);
  }
  set(value: string) {
    this.value = value;
  }
}

/* eslint-disable @typescript-eslint/require-await -- deterministic test adapter */
class MemoryAuthStore implements AuthStore {
  accounts = new Map<string, AuthAccount>();
  sessions = new Map<string, AuthSession>();
  async createAccount(account: AuthAccount) {
    if (
      [...this.accounts.values()].some(
        (value) => value.normalizedUsername === account.normalizedUsername,
      )
    )
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    this.accounts.set(account.id, account);
    return account;
  }
  async findAccountByNormalizedUsername(username: string) {
    return [...this.accounts.values()].find(
      (value) => value.normalizedUsername === username,
    );
  }
  async findAccountById(id: string) {
    return this.accounts.get(id);
  }
  async updateProfile(
    id: string,
    profile: Pick<
      AuthAccount,
      'username' | 'normalizedUsername' | 'displayName' | 'avatar'
    >,
    expectedVersion: number,
  ) {
    const account = this.accounts.get(id);
    if (!account || account.profileVersion !== expectedVersion)
      return undefined;
    if (
      [...this.accounts.values()].some(
        (value) =>
          value.id !== id &&
          value.normalizedUsername === profile.normalizedUsername,
      )
    )
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    const updated = {
      ...account,
      ...profile,
      profileVersion: account.profileVersion + 1,
      updatedAt: new Date().toISOString(),
    };
    this.accounts.set(id, updated);
    return updated;
  }
  async updatePasswordHash(id: string, passwordHash: string) {
    const account = this.accounts.get(id);
    if (account) this.accounts.set(id, { ...account, passwordHash });
  }
  async resetCredentials(id: string, passwordHash: string) {
    const account = this.accounts.get(id);
    if (account)
      this.accounts.set(id, {
        ...account,
        passwordHash,
        credentialVersion: account.credentialVersion + 1,
      });
  }
  async createSession(session: AuthSession) {
    this.sessions.set(session.id, session);
    return session;
  }
  async findSessionByTokenHash(hash: string) {
    return [...this.sessions.values()].find(
      (value) => value.tokenHash === hash,
    );
  }
  async touchSession(id: string, lastSeenAt: string, idleExpiresAt: string) {
    const value = this.sessions.get(id);
    if (!value || value.revokedAt) return false;
    this.sessions.set(id, { ...value, lastSeenAt, idleExpiresAt });
    return true;
  }
  async revokeSession(id: string, revokedAt: string) {
    const value = this.sessions.get(id);
    if (!value) return false;
    this.sessions.set(id, {
      ...value,
      revokedAt: value.revokedAt ?? revokedAt,
    });
    return true;
  }
  async revokeAllSessions(accountId: string, revokedAt: string) {
    let count = 0;
    for (const [id, value] of this.sessions)
      if (value.accountId === accountId && !value.revokedAt) {
        this.sessions.set(id, { ...value, revokedAt });
        count += 1;
      }
    return count;
  }
  async listSessions(accountId: string) {
    return [...this.sessions.values()].filter(
      (value) => value.accountId === accountId,
    );
  }
  async transaction<T>(work: (store: AuthStore) => Promise<T>): Promise<T> {
    const accounts = new Map(this.accounts);
    const sessions = new Map(this.sessions);
    try {
      return await work(this);
    } catch (error) {
      this.accounts = accounts;
      this.sessions = sessions;
      throw error;
    }
  }
}
/* eslint-enable @typescript-eslint/require-await */
