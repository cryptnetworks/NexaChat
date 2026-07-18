import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import * as nodeCrypto from 'node:crypto';

export interface AuthAccount {
  id: string;
  username: string;
  normalizedUsername: string;
  displayName: string;
  passwordHash: string;
  status: 'active' | 'suspended';
  credentialVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  id: string;
  accountId: string;
  tokenHash: string;
  credentialVersion: number;
  createdAt: string;
  lastSeenAt: string;
  recentAuthAt: string;
  expiresAt: string;
  idleExpiresAt: string;
  revokedAt: string | null;
}

export interface AuthStore {
  createAccount(account: AuthAccount): Promise<AuthAccount>;
  findAccountByNormalizedUsername(
    username: string,
  ): Promise<AuthAccount | undefined>;
  findAccountById(id: string): Promise<AuthAccount | undefined>;
  updatePasswordHash(id: string, passwordHash: string): Promise<void>;
  resetCredentials(id: string, passwordHash: string): Promise<void>;
  createSession(session: AuthSession): Promise<AuthSession>;
  findSessionByTokenHash(tokenHash: string): Promise<AuthSession | undefined>;
  touchSession(
    id: string,
    lastSeenAt: string,
    idleExpiresAt: string,
  ): Promise<boolean>;
  revokeSession(id: string, revokedAt: string): Promise<boolean>;
  revokeAllSessions(accountId: string, revokedAt: string): Promise<number>;
  listSessions(accountId: string): Promise<AuthSession[]>;
  transaction<T>(work: (store: AuthStore) => Promise<T>): Promise<T>;
}

export class InMemoryAuthStore implements AuthStore {
  readonly accounts = new Map<string, AuthAccount>();
  readonly sessions = new Map<string, AuthSession>();
  createAccount(account: AuthAccount): Promise<AuthAccount> {
    if (
      [...this.accounts.values()].some(
        (value) => value.normalizedUsername === account.normalizedUsername,
      )
    )
      return Promise.reject(
        Object.assign(new Error('duplicate'), { code: '23505' }),
      );
    this.accounts.set(account.id, account);
    return Promise.resolve(account);
  }
  findAccountByNormalizedUsername(
    username: string,
  ): Promise<AuthAccount | undefined> {
    return Promise.resolve(
      [...this.accounts.values()].find(
        (value) => value.normalizedUsername === username,
      ),
    );
  }
  findAccountById(id: string): Promise<AuthAccount | undefined> {
    return Promise.resolve(this.accounts.get(id));
  }
  updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    const account = this.accounts.get(id);
    if (account) this.accounts.set(id, { ...account, passwordHash });
    return Promise.resolve();
  }
  resetCredentials(id: string, passwordHash: string): Promise<void> {
    const account = this.accounts.get(id);
    if (account)
      this.accounts.set(id, {
        ...account,
        passwordHash,
        credentialVersion: account.credentialVersion + 1,
      });
    return Promise.resolve();
  }
  createSession(session: AuthSession): Promise<AuthSession> {
    this.sessions.set(session.id, session);
    return Promise.resolve(session);
  }
  findSessionByTokenHash(hash: string): Promise<AuthSession | undefined> {
    return Promise.resolve(
      [...this.sessions.values()].find((value) => value.tokenHash === hash),
    );
  }
  touchSession(
    id: string,
    lastSeenAt: string,
    idleExpiresAt: string,
  ): Promise<boolean> {
    const value = this.sessions.get(id);
    if (!value || value.revokedAt) return Promise.resolve(false);
    this.sessions.set(id, { ...value, lastSeenAt, idleExpiresAt });
    return Promise.resolve(true);
  }
  revokeSession(id: string, revokedAt: string): Promise<boolean> {
    const value = this.sessions.get(id);
    if (!value) return Promise.resolve(false);
    this.sessions.set(id, {
      ...value,
      revokedAt: value.revokedAt ?? revokedAt,
    });
    return Promise.resolve(true);
  }
  revokeAllSessions(accountId: string, revokedAt: string): Promise<number> {
    let count = 0;
    for (const [id, value] of this.sessions)
      if (value.accountId === accountId && !value.revokedAt) {
        this.sessions.set(id, { ...value, revokedAt });
        count += 1;
      }
    return Promise.resolve(count);
  }
  listSessions(accountId: string): Promise<AuthSession[]> {
    return Promise.resolve(
      [...this.sessions.values()].filter(
        (value) => value.accountId === accountId,
      ),
    );
  }
  async transaction<T>(work: (store: AuthStore) => Promise<T>): Promise<T> {
    const accounts = new Map(this.accounts);
    const sessions = new Map(this.sessions);
    try {
      return await work(this);
    } catch (error) {
      this.accounts.clear();
      this.sessions.clear();
      for (const entry of accounts) this.accounts.set(...entry);
      for (const entry of sessions) this.sessions.set(...entry);
      throw error;
    }
  }
}

export interface Clock {
  now(): Date;
}

export interface PasswordHashParameters {
  memoryKiB: number;
  passes: number;
  parallelism: number;
  tagLength: number;
  saltLength: number;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encoded: string): Promise<boolean>;
  needsRehash(encoded: string): boolean;
  dummyHash(): string;
}

export interface RateLimiter {
  consume(keys: string[], now: Date): Promise<boolean>;
}

export interface AuthenticationConfig {
  absoluteSessionMs: number;
  idleSessionMs: number;
}

export type AuthenticationErrorCode =
  | 'authentication_failed'
  | 'identifier_unavailable'
  | 'rate_limited'
  | 'unauthenticated';

export class AuthenticationError extends Error {
  constructor(public readonly code: AuthenticationErrorCode) {
    super(code);
  }
}

export class AuthenticationService {
  constructor(
    private readonly store: AuthStore,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
    private readonly config: AuthenticationConfig,
    private readonly tokenBytes: (size: number) => Buffer = randomBytes,
  ) {}

  async register(input: {
    username: string;
    displayName: string;
    password: string;
    source: string;
  }): Promise<{ account: PublicAccount; session: IssuedSession }> {
    const normalizedUsername = normalizeUsername(input.username);
    if (!validNormalizedUsername(normalizedUsername))
      throw new AuthenticationError('identifier_unavailable');
    await this.enforceRateLimit(input.source, normalizedUsername);
    const now = this.clock.now().toISOString();
    const account: AuthAccount = {
      id: randomUUID(),
      username: input.username.trim(),
      normalizedUsername,
      displayName: input.displayName.trim(),
      passwordHash: await this.hasher.hash(input.password),
      status: 'active',
      credentialVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    try {
      return await this.store.transaction(async (store) => {
        await store.createAccount(account);
        return {
          account: publicAccount(account),
          session: await this.issueSession(account, this.clock.now(), store),
        };
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AuthenticationError('identifier_unavailable');
      throw error;
    }
  }

  async login(input: {
    username: string;
    password: string;
    source: string;
  }): Promise<{ account: PublicAccount; session: IssuedSession }> {
    const normalizedUsername = normalizeUsername(input.username);
    if (!validNormalizedUsername(normalizedUsername))
      throw new AuthenticationError('authentication_failed');
    await this.enforceRateLimit(input.source, normalizedUsername);
    const account =
      await this.store.findAccountByNormalizedUsername(normalizedUsername);
    const valid = await this.hasher.verify(
      input.password,
      account?.passwordHash ?? this.hasher.dummyHash(),
    );
    if (!account || !valid || account.status !== 'active')
      throw new AuthenticationError('authentication_failed');
    if (this.hasher.needsRehash(account.passwordHash)) {
      await this.store.updatePasswordHash(
        account.id,
        await this.hasher.hash(input.password),
      );
    }
    return {
      account: publicAccount(account),
      session: await this.issueSession(account, this.clock.now()),
    };
  }

  async authenticate(token: string): Promise<AuthenticatedSession> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new AuthenticationError('unauthenticated');
    const tokenHash = protectSessionToken(token);
    const session = await this.store.findSessionByTokenHash(tokenHash);
    if (
      !session ||
      !timingSafeEqual(Buffer.from(tokenHash), Buffer.from(session.tokenHash))
    )
      throw new AuthenticationError('unauthenticated');
    const account = await this.store.findAccountById(session.accountId);
    const now = this.clock.now();
    if (
      !account ||
      account.status !== 'active' ||
      account.credentialVersion !== session.credentialVersion ||
      session.revokedAt !== null ||
      now >= new Date(session.expiresAt) ||
      now >= new Date(session.idleExpiresAt)
    )
      throw new AuthenticationError('unauthenticated');
    const idleExpiresAt = new Date(
      Math.min(
        now.getTime() + this.config.idleSessionMs,
        new Date(session.expiresAt).getTime(),
      ),
    ).toISOString();
    if (
      !(await this.store.touchSession(
        session.id,
        now.toISOString(),
        idleExpiresAt,
      ))
    )
      throw new AuthenticationError('unauthenticated');
    return {
      account: publicAccount(account),
      session: { ...session, idleExpiresAt },
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.store.revokeSession(sessionId, this.clock.now().toISOString());
  }

  async logoutAll(accountId: string): Promise<void> {
    await this.store.revokeAllSessions(
      accountId,
      this.clock.now().toISOString(),
    );
  }

  async resetCredentials(accountId: string, password: string): Promise<void> {
    const passwordHash = await this.hasher.hash(password);
    const revokedAt = this.clock.now().toISOString();
    await this.store.transaction(async (store) => {
      await store.resetCredentials(accountId, passwordHash);
      await store.revokeAllSessions(accountId, revokedAt);
    });
  }

  listSessions(accountId: string): Promise<AuthSession[]> {
    return this.store.listSessions(accountId);
  }

  private async enforceRateLimit(source: string, identifier: string) {
    try {
      const allowed = await this.limiter.consume(
        [`source:${source}`, `identifier:${identifier}`],
        this.clock.now(),
      );
      if (!allowed) throw new AuthenticationError('rate_limited');
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError('rate_limited');
    }
  }

  private async issueSession(
    account: AuthAccount,
    now: Date,
    store: AuthStore = this.store,
  ): Promise<IssuedSession> {
    const token = this.tokenBytes(32).toString('base64url');
    const session: AuthSession = {
      id: randomUUID(),
      accountId: account.id,
      tokenHash: protectSessionToken(token),
      credentialVersion: account.credentialVersion,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      recentAuthAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.config.absoluteSessionMs,
      ).toISOString(),
      idleExpiresAt: new Date(
        now.getTime() + this.config.idleSessionMs,
      ).toISOString(),
      revokedAt: null,
    };
    await store.createSession(session);
    return { token, record: session };
  }
}

export interface PublicAccount {
  id: string;
  username: string;
  displayName: string;
}
export interface IssuedSession {
  token: string;
  record: AuthSession;
}
export interface AuthenticatedSession {
  account: PublicAccount;
  session: AuthSession;
}

export function normalizeUsername(username: string): string {
  return username.trim().normalize('NFKC').toLowerCase();
}

function validNormalizedUsername(username: string): boolean {
  const length = Array.from(username).length;
  return length >= 3 && length <= 32 && /^[\p{L}\p{N}_.-]+$/u.test(username);
}

export function protectSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createArgon2idHasher(
  parameters: PasswordHashParameters,
): PasswordHasher {
  validateHashParameters(parameters);
  const derive = (
    password: string,
    salt: Buffer,
    selected: PasswordHashParameters = parameters,
  ) =>
    new Promise<Buffer>((resolve, reject) => {
      const argon2 = (nodeCrypto as unknown as { argon2: Argon2Function })
        .argon2;
      argon2(
        'argon2id',
        {
          message: Buffer.from(password, 'utf8'),
          nonce: salt,
          parallelism: selected.parallelism,
          tagLength: selected.tagLength,
          memory: selected.memoryKiB,
          passes: selected.passes,
        },
        (error, key) => {
          if (error) reject(error);
          else resolve(key);
        },
      );
    });
  return {
    async hash(password) {
      const salt = randomBytes(parameters.saltLength);
      const key = await derive(password, salt);
      return encodeHash(parameters, salt, key);
    },
    async verify(password, encoded) {
      const parsed = parseHash(encoded);
      if (!parsed) return false;
      const candidate = await derive(password, parsed.salt, parsed.parameters);
      return (
        candidate.length === parsed.key.length &&
        timingSafeEqual(candidate, parsed.key)
      );
    },
    needsRehash(encoded) {
      const parsed = parseHash(encoded);
      return (
        !parsed ||
        JSON.stringify(parsed.parameters) !== JSON.stringify(parameters)
      );
    },
    dummyHash() {
      return encodeHash(
        parameters,
        Buffer.alloc(parameters.saltLength),
        Buffer.alloc(parameters.tagLength),
      );
    },
  };
}

type Argon2Function = (
  algorithm: 'argon2id',
  parameters: {
    message: Buffer;
    nonce: Buffer;
    parallelism: number;
    tagLength: number;
    memory: number;
    passes: number;
  },
  callback: (error: Error | null, key: Buffer) => void,
) => void;

export function validateHashParameters(p: PasswordHashParameters): void {
  if (
    !Number.isInteger(p.memoryKiB) ||
    p.memoryKiB < 19_456 ||
    p.memoryKiB > 262_144
  )
    throw new Error('Argon2 memory must be 19456..262144 KiB');
  if (!Number.isInteger(p.passes) || p.passes < 2 || p.passes > 10)
    throw new Error('Argon2 passes must be 2..10');
  if (
    !Number.isInteger(p.parallelism) ||
    p.parallelism < 1 ||
    p.parallelism > 8
  )
    throw new Error('Argon2 parallelism must be 1..8');
  if (!Number.isInteger(p.tagLength) || p.tagLength < 16 || p.tagLength > 64)
    throw new Error('Argon2 tag length must be 16..64');
  if (!Number.isInteger(p.saltLength) || p.saltLength < 16 || p.saltLength > 64)
    throw new Error('Argon2 salt length must be 16..64');
}

export class FixedWindowRateLimiter implements RateLimiter {
  private readonly buckets = new Map<
    string,
    { count: number; startsAt: number }
  >();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  consume(keys: string[], now: Date): Promise<boolean> {
    const timestamp = now.getTime();
    const entries = keys.map((key) => {
      const current = this.buckets.get(key);
      return !current || timestamp - current.startsAt >= this.windowMs
        ? { key, value: { count: 0, startsAt: timestamp } }
        : { key, value: current };
    });
    if (entries.some(({ value }) => value.count >= this.limit))
      return Promise.resolve(false);
    for (const { key, value } of entries)
      this.buckets.set(key, { ...value, count: value.count + 1 });
    return Promise.resolve(true);
  }
}

function publicAccount(account: AuthAccount): PublicAccount {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

function encodeHash(
  p: PasswordHashParameters,
  salt: Buffer,
  key: Buffer,
): string {
  return `$argon2id$nexa$v=1$m=${String(p.memoryKiB)},t=${String(p.passes)},p=${String(p.parallelism)},l=${String(p.tagLength)},s=${String(p.saltLength)}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function parseHash(
  encoded: string,
):
  | { parameters: PasswordHashParameters; salt: Buffer; key: Buffer }
  | undefined {
  const match =
    /^\$argon2id\$nexa\$v=1\$m=(\d+),t=(\d+),p=(\d+),l=(\d+),s=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(
      encoded,
    );
  if (!match) return undefined;
  const parameters = {
    memoryKiB: Number(match[1]),
    passes: Number(match[2]),
    parallelism: Number(match[3]),
    tagLength: Number(match[4]),
    saltLength: Number(match[5]),
  };
  try {
    validateHashParameters(parameters);
    const salt = Buffer.from(match[6] ?? '', 'base64url');
    const key = Buffer.from(match[7] ?? '', 'base64url');
    if (
      salt.length !== parameters.saltLength ||
      key.length !== parameters.tagLength
    )
      return undefined;
    return { parameters, salt, key };
  } catch {
    return undefined;
  }
}
