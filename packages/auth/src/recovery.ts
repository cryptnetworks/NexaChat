import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import type { AuthAccount, PasswordHasher } from './index.js';

export type RecoveryMethodKind = 'email' | 'phone' | 'security_key';
export type RecoveryMethodState = 'pending' | 'verified' | 'revoked';
export type RecoveryChallengePurpose =
  | 'account_recovery'
  | 'method_enrollment'
  | 'method_replacement'
  | 'method_revocation';
export type RecoveryChallengeState =
  'pending' | 'used' | 'expired' | 'invalidated';

export interface RecoveryAccount extends AuthAccount {
  recoveryEpoch: number;
  recoveryLocked: boolean;
}

export interface RecoveryMethod {
  id: string;
  accountId: string;
  kind: RecoveryMethodKind;
  destinationCiphertext: string;
  destinationDigest: string;
  state: RecoveryMethodState;
  createdAt: string;
  lastVerifiedAt: string | null;
  version: number;
}

export interface RecoveryChallenge {
  id: string;
  accountId: string;
  methodId: string | null;
  purpose: RecoveryChallengePurpose;
  tokenHash: string;
  epoch: number;
  state: RecoveryChallengeState;
  attempts: number;
  maxAttempts: number;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
  version: number;
}

export interface RecoverySecurityEvent {
  id: string;
  accountId: string;
  action:
    | 'account.recovery.request'
    | 'account.recovery.complete'
    | 'account.recovery.method.verify'
    | 'account.recovery.method.revoke'
    | 'account.recovery.operator.lock'
    | 'account.recovery.operator.unlock'
    | 'account.recovery.operator.invalidate';
  outcome: 'succeeded' | 'rejected';
  correlationId: string;
  occurredAt: string;
}

export interface RecoveryStore {
  findAccountByNormalizedUsername(
    username: string,
  ): Promise<RecoveryAccount | undefined>;
  findAccountById(id: string): Promise<RecoveryAccount | undefined>;
  createChallenge(challenge: RecoveryChallenge): Promise<void>;
  findChallengeByTokenHash(
    tokenHash: string,
  ): Promise<RecoveryChallenge | undefined>;
  consumeChallenge(
    id: string,
    expectedVersion: number,
    now: string,
  ): Promise<boolean>;
  updateChallengeState(
    id: string,
    expectedVersion: number,
    state: Extract<RecoveryChallengeState, 'expired' | 'invalidated'>,
  ): Promise<boolean>;
  changeCredentials(
    accountId: string,
    expectedCredentialVersion: number,
    passwordHash: string,
  ): Promise<RecoveryAccount | undefined>;
  revokeAllSessions(accountId: string, revokedAt: string): Promise<number>;
  createMethod(method: RecoveryMethod): Promise<RecoveryMethod>;
  findMethod(
    accountId: string,
    methodId: string,
  ): Promise<RecoveryMethod | undefined>;
  listMethods(accountId: string): Promise<RecoveryMethod[]>;
  verifyMethod(
    accountId: string,
    methodId: string,
    expectedVersion: number,
    verifiedAt: string,
  ): Promise<RecoveryMethod | undefined>;
  revokeMethod(
    accountId: string,
    methodId: string,
    expectedVersion: number,
  ): Promise<RecoveryMethod | undefined>;
  updateRecoveryLock(accountId: string, locked: boolean): Promise<boolean>;
  invalidateChallenges(accountId: string, epoch: number): Promise<number>;
  recordSecurityEvent(event: RecoverySecurityEvent): Promise<void>;
  transaction<T>(work: (store: RecoveryStore) => Promise<T>): Promise<T>;
}

export interface RecoveryClock {
  now(): Date;
}

export interface RecoveryRateLimiter {
  consume(keys: string[], now: Date): Promise<boolean>;
}

export interface RecoveryCounter {
  increment(key: string, ttlSeconds: number): Promise<{ count: number }>;
}

export class DistributedRecoveryRateLimiter implements RecoveryRateLimiter {
  private readonly local = new Map<
    string,
    { count: number; startsAt: number }
  >();

  constructor(
    private readonly counter: RecoveryCounter | undefined,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxLocalBuckets = 10_000,
  ) {}

  async consume(keys: string[], now: Date): Promise<boolean> {
    const digest = createHash('sha256')
      .update('nexa-recovery-rate\0')
      .update([...new Set(keys)].sort().join('\0'))
      .digest('hex');
    if (this.counter) {
      try {
        const result = await this.counter.increment(
          `recovery:${digest}`,
          Math.max(1, Math.ceil(this.windowMs / 1000)),
        );
        return result.count <= this.limit;
      } catch {
        return false;
      }
    }
    const current = this.local.get(digest);
    const value =
      !current || now.getTime() - current.startsAt >= this.windowMs
        ? { count: 0, startsAt: now.getTime() }
        : current;
    if (value.count >= this.limit) return false;
    value.count += 1;
    this.local.delete(digest);
    this.local.set(digest, value);
    while (this.local.size > this.maxLocalBuckets) {
      const oldest = this.local.keys().next().value;
      if (oldest === undefined) break;
      this.local.delete(oldest);
    }
    return true;
  }
}

export interface RecoveryConfig {
  recoveryExpiryMs?: number;
  verificationExpiryMs?: number;
  maxAttempts?: number;
}

export interface RecoveryIssue {
  accepted: true;
  token?: string;
}

export class RecoveryError extends Error {
  constructor(
    public readonly code:
      'recovery_failed' | 'recovery_rate_limited' | 'invalid_recovery_request',
  ) {
    super(code);
  }
}

const recoveryExpiryMs = 30 * 60 * 1000;
const verificationExpiryMs = 15 * 60 * 1000;
const maxAttempts = 5;

export class RecoveryService {
  private readonly config: Required<RecoveryConfig>;

  constructor(
    private readonly store: RecoveryStore,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RecoveryRateLimiter,
    private readonly clock: RecoveryClock,
    config: RecoveryConfig = {},
    private readonly tokenBytes: (size: number) => Buffer = randomBytes,
  ) {
    this.config = {
      recoveryExpiryMs: config.recoveryExpiryMs ?? recoveryExpiryMs,
      verificationExpiryMs: config.verificationExpiryMs ?? verificationExpiryMs,
      maxAttempts: config.maxAttempts ?? maxAttempts,
    };
    if (
      this.config.recoveryExpiryMs <= 0 ||
      this.config.verificationExpiryMs <= 0 ||
      this.config.maxAttempts < 1
    )
      throw new Error('invalid_recovery_configuration');
  }

  async requestRecovery(input: {
    username: string;
    source: string;
  }): Promise<RecoveryIssue> {
    const normalized = input.username.trim().normalize('NFKC').toLowerCase();
    if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(normalized)) return { accepted: true };
    if (
      !(await this.limiter.consume(
        [
          `recovery:source:${input.source}`,
          `recovery:identifier:${normalized}`,
        ],
        this.clock.now(),
      ))
    )
      throw new RecoveryError('recovery_rate_limited');
    const account =
      await this.store.findAccountByNormalizedUsername(normalized);
    if (!account || account.status !== 'active' || account.recoveryLocked)
      return { accepted: true };
    const now = this.clock.now();
    const token = this.tokenBytes(32).toString('base64url');
    const challenge: RecoveryChallenge = {
      id: randomUUID(),
      accountId: account.id,
      methodId: null,
      purpose: 'account_recovery',
      tokenHash: hashRecoveryToken(token),
      epoch: account.recoveryEpoch,
      state: 'pending',
      attempts: 0,
      maxAttempts: this.config.maxAttempts,
      expiresAt: new Date(
        now.getTime() + this.config.recoveryExpiryMs,
      ).toISOString(),
      createdAt: now.toISOString(),
      usedAt: null,
      version: 1,
    };
    await this.store.transaction(async (store) => {
      const current = await store.findAccountById(account.id);
      if (
        !current ||
        current.recoveryEpoch !== account.recoveryEpoch ||
        current.recoveryLocked
      )
        return;
      await store.createChallenge(challenge);
      await store.recordSecurityEvent({
        id: randomUUID(),
        accountId: account.id,
        action: 'account.recovery.request',
        outcome: 'succeeded',
        correlationId: randomUUID(),
        occurredAt: now.toISOString(),
      });
    });
    return { accepted: true, token };
  }

  async completeRecovery(input: {
    token: string;
    newPassword: string;
    correlationId: string;
  }): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.token))
      throw new RecoveryError('recovery_failed');
    if (
      !(await this.limiter.consume(
        [`recovery:token:${hashTokenForLimit(input.token)}`],
        this.clock.now(),
      ))
    )
      throw new RecoveryError('recovery_rate_limited');
    const now = this.clock.now();
    const challenge = await this.store.findChallengeByTokenHash(
      hashRecoveryToken(input.token),
    );
    const passwordHash = await this.hasher.hash(input.newPassword);
    try {
      await this.store.transaction(async (store) => {
        const candidate = challenge
          ? await store.findAccountById(challenge.accountId)
          : undefined;
        if (
          !challenge ||
          !candidate ||
          candidate.status !== 'active' ||
          candidate.recoveryLocked ||
          challenge.purpose !== 'account_recovery' ||
          challenge.epoch !== candidate.recoveryEpoch ||
          challenge.state !== 'pending' ||
          new Date(challenge.expiresAt) <= now ||
          challenge.attempts >= challenge.maxAttempts ||
          hashRecoveryToken(input.token) !== challenge.tokenHash
        )
          throw new RecoveryError('recovery_failed');
        if (
          !(await store.consumeChallenge(
            challenge.id,
            challenge.version,
            now.toISOString(),
          ))
        )
          throw new RecoveryError('recovery_failed');
        const updated = await store.changeCredentials(
          candidate.id,
          candidate.credentialVersion,
          passwordHash,
        );
        if (!updated) throw new RecoveryError('recovery_failed');
        await store.revokeAllSessions(candidate.id, now.toISOString());
        await store.invalidateChallenges(candidate.id, updated.recoveryEpoch);
        await store.recordSecurityEvent({
          id: randomUUID(),
          accountId: candidate.id,
          action: 'account.recovery.complete',
          outcome: 'succeeded',
          correlationId: input.correlationId,
          occurredAt: now.toISOString(),
        });
      });
    } catch (error) {
      if (error instanceof RecoveryError) throw error;
      throw new RecoveryError('recovery_failed');
    }
  }

  async startMethod(input: {
    accountId: string;
    kind: RecoveryMethodKind;
    destinationCiphertext: string;
    destinationDigest: string;
  }): Promise<{ method: RecoveryMethod; token: string }> {
    const now = this.clock.now();
    return this.store.transaction(async (store) => {
      const account = await store.findAccountById(input.accountId);
      if (!account || account.status !== 'active' || account.recoveryLocked)
        throw new RecoveryError('recovery_failed');
      const method: RecoveryMethod = {
        id: randomUUID(),
        accountId: account.id,
        kind: input.kind,
        destinationCiphertext: input.destinationCiphertext,
        destinationDigest: input.destinationDigest,
        state: 'pending',
        createdAt: now.toISOString(),
        lastVerifiedAt: null,
        version: 1,
      };
      const token = this.tokenBytes(32).toString('base64url');
      await store.createMethod(method);
      await store.createChallenge({
        id: randomUUID(),
        accountId: account.id,
        methodId: method.id,
        purpose: 'method_enrollment',
        tokenHash: hashRecoveryToken(token),
        epoch: account.recoveryEpoch,
        state: 'pending',
        attempts: 0,
        maxAttempts: this.config.maxAttempts,
        expiresAt: new Date(
          now.getTime() + this.config.verificationExpiryMs,
        ).toISOString(),
        createdAt: now.toISOString(),
        usedAt: null,
        version: 1,
      });
      return { method, token };
    });
  }

  async verifyMethod(
    accountId: string,
    token: string,
    expectedMethodId?: string,
  ): Promise<RecoveryMethod> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token))
      throw new RecoveryError('recovery_failed');
    const now = this.clock.now();
    const account = await this.store.findAccountById(accountId);
    const challenge = account
      ? await this.store.findChallengeByTokenHash(hashRecoveryToken(token))
      : undefined;
    return this.store.transaction(async (store) => {
      const current = await store.findAccountById(accountId);
      if (
        !current ||
        !challenge ||
        challenge.accountId !== accountId ||
        !challenge.methodId ||
        current.recoveryEpoch !== challenge.epoch ||
        current.recoveryLocked ||
        (expectedMethodId !== undefined &&
          challenge.methodId !== expectedMethodId)
      )
        throw new RecoveryError('recovery_failed');
      if (challenge.state !== 'pending' || new Date(challenge.expiresAt) <= now)
        throw new RecoveryError('recovery_failed');
      if (
        !(await store.consumeChallenge(
          challenge.id,
          challenge.version,
          now.toISOString(),
        ))
      )
        throw new RecoveryError('recovery_failed');
      const method = await store.verifyMethod(
        accountId,
        challenge.methodId,
        1,
        now.toISOString(),
      );
      if (!method) throw new RecoveryError('recovery_failed');
      await store.recordSecurityEvent({
        id: randomUUID(),
        accountId,
        action: 'account.recovery.method.verify',
        outcome: 'succeeded',
        correlationId: randomUUID(),
        occurredAt: now.toISOString(),
      });
      return method;
    });
  }

  async listMethods(accountId: string): Promise<RecoveryMethod[]> {
    return this.store.listMethods(accountId);
  }

  async replaceMethod(input: {
    accountId: string;
    oldMethodId: string;
    kind: RecoveryMethodKind;
    destinationCiphertext: string;
    destinationDigest: string;
  }): Promise<{ method: RecoveryMethod; token: string }> {
    const oldMethod = await this.store.findMethod(
      input.accountId,
      input.oldMethodId,
    );
    if (!oldMethod || oldMethod.state !== 'verified')
      throw new RecoveryError('recovery_failed');
    return this.startMethod({
      accountId: input.accountId,
      kind: input.kind,
      destinationCiphertext: input.destinationCiphertext,
      destinationDigest: input.destinationDigest,
    });
  }

  async revokeMethod(accountId: string, methodId: string): Promise<void> {
    await this.store.transaction(async (store) => {
      const method = await store.findMethod(accountId, methodId);
      if (!method || method.state === 'revoked')
        throw new RecoveryError('recovery_failed');
      if (!(await store.revokeMethod(accountId, methodId, method.version)))
        throw new RecoveryError('recovery_failed');
      await store.recordSecurityEvent({
        id: randomUUID(),
        accountId,
        action: 'account.recovery.method.revoke',
        outcome: 'succeeded',
        correlationId: randomUUID(),
        occurredAt: this.clock.now().toISOString(),
      });
    });
  }

  async setOperatorLock(accountId: string, locked: boolean): Promise<void> {
    if (!(await this.store.updateRecoveryLock(accountId, locked)))
      throw new RecoveryError('recovery_failed');
  }
}

export function hashRecoveryToken(token: string): string {
  return createHash('sha256')
    .update('nexa-recovery-token\0')
    .update(token)
    .digest('hex');
}

function hashTokenForLimit(token: string): string {
  return createHash('sha256')
    .update('nexa-recovery-limit\0')
    .update(token)
    .digest('hex');
}

export function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
