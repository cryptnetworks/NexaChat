import { createClient } from 'redis';

export interface CoordinationConfig {
  url: string;
  namespace: string;
  operationTimeoutMs: number;
  connectTimeoutMs: number;
  circuitFailures: number;
  circuitResetMs: number;
  maxValueBytes: number;
  maxTtlSeconds: number;
}

export interface EphemeralCoordination {
  verify(): Promise<void>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface CoordinationObserver {
  event(
    operation:
      'connect' | 'operation' | 'retry' | 'timeout' | 'degradation' | 'close',
    outcome: 'success' | 'failure' | 'degraded',
    durationMs: number,
  ): void;
}

export class CoordinationError extends Error {
  constructor(
    readonly code: 'invalid_coordination' | 'coordination_unavailable',
  ) {
    super(code);
  }
}

class CoordinationTimeoutError extends Error {}

interface Client {
  readonly isOpen?: boolean;
  connect(): Promise<unknown>;
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { EX: number; NX?: true },
  ): Promise<string | null>;
  del(key: string): Promise<number>;
  quit(): Promise<unknown>;
  destroy(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export class ValkeyCoordination implements EphemeralCoordination {
  private failures = 0;
  private openUntil = 0;
  private connected = false;
  private readonly client: Client;

  constructor(
    private readonly config: CoordinationConfig,
    client?: Client,
    private readonly observer?: CoordinationObserver,
  ) {
    validateConfig(config);
    this.client =
      client ??
      createClient({
        url: config.url,
        socket: {
          connectTimeout: config.connectTimeoutMs,
          reconnectStrategy: false,
        },
      });
    this.client.on('error', () => {
      this.connected = false;
    });
  }

  async verify(): Promise<void> {
    const startedAt = Date.now();
    const retrying = this.failures > 0;
    try {
      if (!this.connected) {
        if (!this.client.isOpen)
          await bounded(this.client.connect(), this.config.connectTimeoutMs);
        this.connected = true;
      }
      if (
        (await bounded(this.client.ping(), this.config.operationTimeoutMs)) !==
        'PONG'
      )
        throw unavailable();
      this.success();
      this.report('connect', 'success', startedAt);
      if (retrying) this.report('retry', 'success', startedAt);
    } catch (error) {
      this.connected = false;
      this.failure();
      this.report(
        error instanceof CoordinationTimeoutError ? 'timeout' : 'connect',
        'failure',
        startedAt,
      );
      if (retrying) this.report('retry', 'failure', startedAt);
      throw unavailable();
    }
  }

  async get(key: string): Promise<string | undefined> {
    const namespacedKey = this.key(key);
    const value = await this.execute(() => this.client.get(namespacedKey));
    return value ?? undefined;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.value(value, ttlSeconds);
    const namespacedKey = this.key(key);
    await this.execute(() =>
      this.client.set(namespacedKey, value, { EX: ttlSeconds }),
    );
  }

  async setIfAbsent(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    this.value(value, ttlSeconds);
    const namespacedKey = this.key(key);
    return (
      (await this.execute(() =>
        this.client.set(namespacedKey, value, { EX: ttlSeconds, NX: true }),
      )) === 'OK'
    );
  }

  async delete(key: string): Promise<boolean> {
    const namespacedKey = this.key(key);
    return (await this.execute(() => this.client.del(namespacedKey))) > 0;
  }

  async close(): Promise<void> {
    const startedAt = Date.now();
    try {
      await bounded(this.client.quit(), this.config.operationTimeoutMs);
      this.report('close', 'success', startedAt);
    } catch (error) {
      try {
        this.client.destroy();
      } catch {
        this.report('close', 'failure', startedAt);
        throw unavailable();
      }
      if (error instanceof CoordinationTimeoutError)
        this.report('timeout', 'failure', startedAt);
      this.report('close', 'degraded', startedAt);
    } finally {
      this.connected = false;
    }
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    if (startedAt < this.openUntil) {
      this.report('degradation', 'degraded', startedAt);
      throw unavailable();
    }
    try {
      const result = await bounded(operation(), this.config.operationTimeoutMs);
      this.success();
      this.report('operation', 'success', startedAt);
      return result;
    } catch (error) {
      this.failure();
      this.report(
        error instanceof CoordinationTimeoutError ? 'timeout' : 'operation',
        'failure',
        startedAt,
      );
      throw unavailable();
    }
  }

  private key(key: string): string {
    if (!/^[a-z0-9][a-z0-9:_-]{0,127}$/.test(key)) throw invalid();
    return `${this.config.namespace}:${key}`;
  }

  private value(value: string, ttlSeconds: number): void {
    if (
      Buffer.byteLength(value) > this.config.maxValueBytes ||
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > this.config.maxTtlSeconds
    )
      throw invalid();
  }

  private success(): void {
    this.failures = 0;
    this.openUntil = 0;
  }
  private failure(): void {
    this.failures += 1;
    if (this.failures >= this.config.circuitFailures)
      this.openUntil = Date.now() + this.config.circuitResetMs;
  }

  private report(
    operation: Parameters<CoordinationObserver['event']>[0],
    outcome: Parameters<CoordinationObserver['event']>[1],
    startedAt: number,
  ): void {
    try {
      this.observer?.event(operation, outcome, Date.now() - startedAt);
    } catch {
      // Observability cannot change coordination behavior.
    }
  }
}

function validateConfig(config: CoordinationConfig): void {
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    throw invalid();
  }
  if (
    !['redis:', 'rediss:'].includes(parsed.protocol) ||
    !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(config.namespace) ||
    config.operationTimeoutMs < 1 ||
    config.connectTimeoutMs < 1 ||
    config.circuitFailures < 1 ||
    config.circuitResetMs < 1 ||
    config.maxValueBytes < 1 ||
    config.maxTtlSeconds < 1
  )
    throw invalid();
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new CoordinationTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
function invalid(): CoordinationError {
  return new CoordinationError('invalid_coordination');
}
function unavailable(): CoordinationError {
  return new CoordinationError('coordination_unavailable');
}
