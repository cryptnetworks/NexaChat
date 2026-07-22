import { createHash } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketPolicyCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

export interface ObjectStorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
  createBucket: boolean;
  maxObjectBytes: number;
  operationTimeoutMs: number;
  cleanupPageSize: number;
}

export interface StoredObject {
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  contentType: string;
}

export interface PrivateObjectStore {
  verify(): Promise<void>;
  put(
    key: string,
    bytes: Uint8Array,
    contentType?: string,
  ): Promise<{ byteLength: number; sha256: string }>;
  get(key: string): Promise<StoredObject>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string, maximum: number): Promise<number>;
  close(): void;
}

export interface ObjectStorageObserver {
  event(
    operation:
      'connect' | 'put' | 'get' | 'delete' | 'list' | 'timeout' | 'close',
    outcome: 'success' | 'failure' | 'degraded',
    durationMs: number,
  ): void;
}

export class ObjectStorageError extends Error {
  constructor(
    readonly code:
      | 'invalid_object'
      | 'object_unavailable'
      | 'integrity_failure'
      | 'bucket_not_private',
  ) {
    super(code);
  }
}

export class S3PrivateObjectStore implements PrivateObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly config: ObjectStorageConfig,
    client?: S3Client,
    private readonly observer?: ObjectStorageObserver,
  ) {
    validateConfig(config);
    const clientConfig: S3ClientConfig = {
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      maxAttempts: 1,
    };
    this.client = client ?? new S3Client(clientConfig);
  }

  async verify(): Promise<void> {
    const startedAt = Date.now();
    await this.observed('connect', startedAt, async () => {
      try {
        await this.client.send(
          new HeadBucketCommand({ Bucket: this.config.bucket }),
          this.options(),
        );
      } catch (error) {
        if (!this.config.createBucket || !missing(error)) throw error;
        await this.client.send(
          new CreateBucketCommand({ Bucket: this.config.bucket }),
          this.options(),
        );
      }
      try {
        const result = await this.client.send(
          new GetBucketPolicyCommand({ Bucket: this.config.bucket }),
          this.options(),
        );
        if (result.Policy) throw new ObjectStorageError('bucket_not_private');
      } catch (error) {
        if (error instanceof ObjectStorageError) throw error;
        if (!missingPolicy(error) && !unsupported(error)) throw error;
      }
    });
  }

  async put(
    key: string,
    bytes: Uint8Array,
    contentType = 'application/octet-stream',
  ) {
    validKey(key);
    if (bytes.byteLength > this.config.maxObjectBytes)
      throw new ObjectStorageError('invalid_object');
    const startedAt = Date.now();
    return this.observed('put', startedAt, async () => {
      const sha256 = digest(bytes);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ContentType: contentType,
          Metadata: { 'nexa-sha256': sha256 },
        }),
        this.options(),
      );
      return { byteLength: bytes.byteLength, sha256 };
    });
  }

  async get(key: string): Promise<StoredObject> {
    validKey(key);
    const startedAt = Date.now();
    return this.observed('get', startedAt, async () => {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
        this.options(),
      );
      if (!result.Body) throw new ObjectStorageError('integrity_failure');
      const bytes = await result.Body.transformToByteArray();
      if (bytes.byteLength > this.config.maxObjectBytes)
        throw new ObjectStorageError('integrity_failure');
      const sha256 = digest(bytes);
      if (
        result.Metadata?.['nexa-sha256'] !== sha256 ||
        result.ContentLength !== bytes.byteLength
      ) {
        throw new ObjectStorageError('integrity_failure');
      }
      return {
        bytes,
        byteLength: bytes.byteLength,
        sha256,
        contentType: result.ContentType ?? 'application/octet-stream',
      };
    });
  }

  async delete(key: string): Promise<void> {
    validKey(key);
    const startedAt = Date.now();
    await this.observed('delete', startedAt, async () => {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
        this.options(),
      );
    });
  }

  async deletePrefix(prefix: string, maximum: number): Promise<number> {
    validKey(prefix);
    if (
      !Number.isInteger(maximum) ||
      maximum < 1 ||
      maximum > this.config.cleanupPageSize
    )
      throw new ObjectStorageError('invalid_object');
    const startedAt = Date.now();
    const listed = await this.observed('list', startedAt, () =>
      this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          MaxKeys: maximum,
        }),
        this.options(),
      ),
    );
    const keys = (listed.Contents ?? []).flatMap((object) =>
      object.Key ? [object.Key] : [],
    );
    for (const key of keys) await this.delete(key);
    return keys.length;
  }

  close(): void {
    const startedAt = Date.now();
    this.client.destroy();
    this.report('close', 'success', startedAt);
  }

  private async observed<T>(
    operation: Exclude<
      Parameters<ObjectStorageObserver['event']>[0],
      'timeout' | 'close'
    >,
    startedAt: number,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await work();
      this.report(operation, 'success', startedAt);
      return result;
    } catch (error) {
      this.report(
        timedOut(error) ? 'timeout' : operation,
        'failure',
        startedAt,
      );
      if (error instanceof ObjectStorageError) throw error;
      throw unavailable();
    }
  }

  private options(): { abortSignal: AbortSignal } {
    return { abortSignal: AbortSignal.timeout(this.config.operationTimeoutMs) };
  }

  private report(
    operation: Parameters<ObjectStorageObserver['event']>[0],
    outcome: Parameters<ObjectStorageObserver['event']>[1],
    startedAt: number,
  ): void {
    try {
      this.observer?.event(operation, outcome, Date.now() - startedAt);
    } catch {
      // Observability cannot change object-storage behavior.
    }
  }
}

function validateConfig(config: ObjectStorageConfig): void {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new ObjectStorageError('invalid_object');
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !config.bucket ||
    !config.accessKeyId ||
    !config.secretAccessKey ||
    config.maxObjectBytes < 1 ||
    config.operationTimeoutMs < 1 ||
    config.cleanupPageSize < 1 ||
    config.cleanupPageSize > 1000
  )
    throw new ObjectStorageError('invalid_object');
}

function validKey(key: string): void {
  if (!/^[a-z0-9][a-z0-9/_-]{0,255}$/.test(key) || key.includes('..')) {
    throw new ObjectStorageError('invalid_object');
  }
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function unavailable(): ObjectStorageError {
  return new ObjectStorageError('object_unavailable');
}

function name(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String(error.name)
    : '';
}

function missing(error: unknown): boolean {
  return ['NotFound', 'NoSuchBucket'].includes(name(error));
}

function missingPolicy(error: unknown): boolean {
  return ['NoSuchBucketPolicy', 'NoSuchPolicy', 'NotFound'].includes(
    name(error),
  );
}

function unsupported(error: unknown): boolean {
  return ['NotImplemented', 'MethodNotAllowed'].includes(name(error));
}

function timedOut(error: unknown): boolean {
  const errorName = name(error);
  return errorName === 'TimeoutError' || errorName === 'AbortError';
}
