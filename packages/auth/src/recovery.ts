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
  actorId?: string;
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

export type RecoveryIdempotencyScope = 'recovery.request' | 'recovery.complete';

export interface RecoveryIdempotencyRecord {
  id: string;
  scope: RecoveryIdempotencyScope;
  idempotencyKey: string;
  requestFingerprint: string;
  state: 'pending' | 'succeeded';
  challengeId: string | null;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  version: number;
}

export interface RecoveryStore {
  findAccountByNormalizedUsername(
    username: string,
  ): Promise<RecoveryAccount | undefined>;
  findAccountById(id: string): Promise<RecoveryAccount | undefined>;
  createChallenge(challenge: RecoveryChallenge): Promise<void>;
  findRecoveryIdempotency(
    scope: RecoveryIdempotencyScope,
    idempotencyKey: string,
  ): Promise<RecoveryIdempotencyRecord | undefined>;
  createRecoveryIdempotency(
    record: RecoveryIdempotencyRecord,
  ): Promise<boolean>;
  completeRecoveryIdempotency(
    scope: RecoveryIdempotencyScope,
    idempotencyKey: string,
    expectedVersion: number,
    challengeId: string | null,
    completedAt: string,
  ): Promise<boolean>;
  assertRecoveryOperator(actorId: string): Promise<boolean>;
  revokeAllMethods(accountId: string): Promise<number>;
  expireChallenges(now: string, limit: number): Promise<number>;
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
  private sessionInvalidationPublisher:
    ((accountId: string) => Promise<void>) | undefined;

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
    idempotencyKey?: string;
  }): Promise<RecoveryIssue> {
    const normalized = input.username.trim().normalize('NFKC').toLowerCase();
    if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(normalized)) return { accepted: true };
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const fingerprint = recoveryFingerprint('recovery.request', normalized);
    const existing = await this.store.findRecoveryIdempotency(
      'recovery.request',
      idempotencyKey,
    );
    if (existing) {
      if (existing.requestFingerprint !== fingerprint)
        throw new RecoveryError('recovery_failed');
      if (existing.state === 'succeeded') return { accepted: true };
      throw new RecoveryError('recovery_failed');
    }
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
    const issued = await this.store.transaction(async (store) => {
      const currentIdempotency = await store.findRecoveryIdempotency(
        'recovery.request',
        idempotencyKey,
      );
      if (currentIdempotency) {
        if (currentIdempotency.requestFingerprint !== fingerprint)
          throw new RecoveryError('recovery_failed');
        return false;
      }
      const idempotency: RecoveryIdempotencyRecord = {
        id: randomUUID(),
        scope: 'recovery.request',
        idempotencyKey,
        requestFingerprint: fingerprint,
        state: 'pending',
        challengeId: null,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + this.config.recoveryExpiryMs,
        ).toISOString(),
        completedAt: null,
        version: 1,
      };
      if (!(await store.createRecoveryIdempotency(idempotency))) return false;
      const current = await store.findAccountById(account.id);
      if (
        !current ||
        current.recoveryEpoch !== account.recoveryEpoch ||
        current.recoveryLocked
      ) {
        await store.completeRecoveryIdempotency(
          'recovery.request',
          idempotencyKey,
          idempotency.version,
          null,
          now.toISOString(),
        );
        return;
      }
      await store.createChallenge(challenge);
      await store.completeRecoveryIdempotency(
        'recovery.request',
        idempotencyKey,
        idempotency.version,
        challenge.id,
        now.toISOString(),
      );
      await store.recordSecurityEvent({
        id: randomUUID(),
        accountId: account.id,
        action: 'account.recovery.request',
        outcome: 'succeeded',
        correlationId: randomUUID(),
        occurredAt: now.toISOString(),
      });
      return true;
    });
    return issued ? { accepted: true, token } : { accepted: true };
  }

  async completeRecovery(input: {
    token: string;
    newPassword: string;
    correlationId: string;
    idempotencyKey?: string;
  }): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.token))
      throw new RecoveryError('recovery_failed');
    const tokenHash = hashRecoveryToken(input.token);
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const fingerprint = recoveryFingerprint(
      'recovery.complete',
      `${tokenHash}\0${createHash('sha256').update(input.newPassword).digest('hex')}`,
    );
    const existing = await this.store.findRecoveryIdempotency(
      'recovery.complete',
      idempotencyKey,
    );
    if (existing) {
      if (existing.requestFingerprint !== fingerprint)
        throw new RecoveryError('recovery_failed');
      if (existing.state === 'succeeded') return;
      throw new RecoveryError('recovery_failed');
    }
    if (
      !(await this.limiter.consume(
        [`recovery:token:${hashTokenForLimit(input.token)}`],
        this.clock.now(),
      ))
    )
      throw new RecoveryError('recovery_rate_limited');
    const now = this.clock.now();
    const passwordHash = await this.hasher.hash(input.newPassword);
    let invalidatedAccountId: string | undefined;
    try {
      await this.store.transaction(async (store) => {
        const currentIdempotency = await store.findRecoveryIdempotency(
          'recovery.complete',
          idempotencyKey,
        );
        if (currentIdempotency) {
          if (currentIdempotency.requestFingerprint !== fingerprint)
            throw new RecoveryError('recovery_failed');
          if (currentIdempotency.state === 'succeeded') return;
          throw new RecoveryError('recovery_failed');
        }
        const idempotency: RecoveryIdempotencyRecord = {
          id: randomUUID(),
          scope: 'recovery.complete',
          idempotencyKey,
          requestFingerprint: fingerprint,
          state: 'pending',
          challengeId: null,
          createdAt: now.toISOString(),
          expiresAt: new Date(
            now.getTime() + this.config.recoveryExpiryMs,
          ).toISOString(),
          completedAt: null,
          version: 1,
        };
        if (!(await store.createRecoveryIdempotency(idempotency)))
          throw new RecoveryError('recovery_failed');
        const challenge = await store.findChallengeByTokenHash(tokenHash);
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
          tokenHash !== challenge.tokenHash
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
        invalidatedAccountId = candidate.id;
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
        await store.completeRecoveryIdempotency(
          'recovery.complete',
          idempotencyKey,
          idempotency.version,
          challenge.id,
          now.toISOString(),
        );
      });
      if (invalidatedAccountId && this.sessionInvalidationPublisher)
        await this.sessionInvalidationPublisher(invalidatedAccountId);
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
    const now = this.clock.now();
    return this.store.transaction(async (store) => {
      const account = await store.findAccountById(input.accountId);
      const oldMethod = account
        ? await store.findMethod(input.accountId, input.oldMethodId)
        : undefined;
      if (
        !account ||
        account.status !== 'active' ||
        account.recoveryLocked ||
        !oldMethod ||
        oldMethod.state !== 'verified'
      )
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
        purpose: 'method_replacement',
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

  async expireChallenges(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new RecoveryError('invalid_recovery_request');
    return this.store.expireChallenges(this.clock.now().toISOString(), limit);
  }

  setSessionInvalidationPublisher(
    publisher: (accountId: string) => Promise<void>,
  ): void {
    this.sessionInvalidationPublisher = publisher;
  }

  async operatorLock(input: {
    actorId: string;
    accountId: string;
    locked: boolean;
    authenticatedAt: string;
    correlationId: string;
  }): Promise<void> {
    await this.assertOperator(input.actorId, input.authenticatedAt);
    await this.store.transaction(async (store) => {
      const account = await store.findAccountById(input.accountId);
      if (!account) throw new RecoveryError('recovery_failed');
      if (!(await store.updateRecoveryLock(account.id, input.locked)))
        throw new RecoveryError('recovery_failed');
      if (input.locked)
        await store.invalidateChallenges(account.id, Number.MAX_SAFE_INTEGER);
      await store.recordSecurityEvent({
        id: randomUUID(),
        actorId: input.actorId,
        accountId: account.id,
        action: input.locked
          ? 'account.recovery.operator.lock'
          : 'account.recovery.operator.unlock',
        outcome: 'succeeded',
        correlationId: input.correlationId,
        occurredAt: this.clock.now().toISOString(),
      });
    });
  }

  async operatorInvalidate(input: {
    actorId: string;
    accountId: string;
    authenticatedAt: string;
    correlationId: string;
  }): Promise<void> {
    await this.assertOperator(input.actorId, input.authenticatedAt);
    await this.store.transaction(async (store) => {
      const account = await store.findAccountById(input.accountId);
      if (!account) throw new RecoveryError('recovery_failed');
      await store.invalidateChallenges(account.id, Number.MAX_SAFE_INTEGER);
      await store.recordSecurityEvent({
        id: randomUUID(),
        actorId: input.actorId,
        accountId: account.id,
        action: 'account.recovery.operator.invalidate',
        outcome: 'succeeded',
        correlationId: input.correlationId,
        occurredAt: this.clock.now().toISOString(),
      });
    });
  }

  async operatorRevoke(input: {
    actorId: string;
    accountId: string;
    authenticatedAt: string;
    correlationId: string;
  }): Promise<void> {
    await this.assertOperator(input.actorId, input.authenticatedAt);
    await this.store.transaction(async (store) => {
      const account = await store.findAccountById(input.accountId);
      if (!account) throw new RecoveryError('recovery_failed');
      await store.revokeAllMethods(account.id);
      await store.recordSecurityEvent({
        id: randomUUID(),
        actorId: input.actorId,
        accountId: account.id,
        action: 'account.recovery.operator.invalidate',
        outcome: 'succeeded',
        correlationId: input.correlationId,
        occurredAt: this.clock.now().toISOString(),
      });
    });
  }

  private async assertOperator(
    actorId: string,
    authenticatedAt: string,
  ): Promise<void> {
    const authenticatedAtMs = Date.parse(authenticatedAt);
    const nowMs = this.clock.now().getTime();
    if (
      !Number.isFinite(authenticatedAtMs) ||
      authenticatedAtMs > nowMs ||
      nowMs - authenticatedAtMs > 15 * 60 * 1000 ||
      !(await this.store.assertRecoveryOperator(actorId))
    )
      throw new RecoveryError('recovery_failed');
  }
}

export function hashRecoveryToken(token: string): string {
  return createHash('sha256')
    .update('nexa-recovery-token\0')
    .update(token)
    .digest('hex');
}

function recoveryFingerprint(
  scope: RecoveryIdempotencyScope,
  value: string,
): string {
  return createHash('sha256')
    .update('nexa-recovery-idempotency\0')
    .update(scope)
    .update('\0')
    .update(value)
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
