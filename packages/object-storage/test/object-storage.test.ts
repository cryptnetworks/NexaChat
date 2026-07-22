import { describe, expect, it } from 'vitest';
import {
  CreateBucketCommand,
  GetBucketPolicyCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { vi } from 'vitest';
import {
  ObjectStorageError,
  S3PrivateObjectStore,
  type ObjectStorageConfig,
} from '../src/index.js';

const integrationEndpoint = process.env.OBJECT_STORAGE_TEST_URL;
const integration = integrationEndpoint ? describe : describe.skip;

describe('private object storage bounds', () => {
  it('rejects invalid configuration, keys, cleanup bounds, and oversized bytes', async () => {
    expect(
      () => new S3PrivateObjectStore({ ...config, maxObjectBytes: 0 }),
    ).toThrow(new ObjectStorageError('invalid_object'));
    const store = new S3PrivateObjectStore(
      config,
      new S3Client({ region: 'us-east-1' }),
    );
    await expect(
      store.put('../escape', new Uint8Array()),
    ).rejects.toMatchObject({
      code: 'invalid_object',
    });
    await expect(
      store.put('safe/key', new Uint8Array(17)),
    ).rejects.toMatchObject({
      code: 'invalid_object',
    });
    await expect(store.deletePrefix('safe/', 3)).rejects.toMatchObject({
      code: 'invalid_object',
    });
  });

  it('creates a missing bucket and verifies that no bucket policy exists', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('missing'), { name: 'NotFound' }),
      )
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        Object.assign(new Error('private'), { name: 'NoSuchBucketPolicy' }),
      );
    const client = { send, destroy: vi.fn() } as unknown as S3Client;
    const store = new S3PrivateObjectStore(
      { ...config, createBucket: true },
      client,
    );
    await store.verify();
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(CreateBucketCommand);
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(GetBucketPolicyCommand);
  });

  it('rejects any bucket policy instead of assuming it is private', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Policy: '{}' });
    const store = new S3PrivateObjectStore(config, {
      send,
      destroy: vi.fn(),
    } as unknown as S3Client);
    await expect(store.verify()).rejects.toMatchObject({
      code: 'bucket_not_private',
    });
  });

  it('writes integrity metadata and detects altered reads', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Body: {
          transformToByteArray: () =>
            Promise.resolve(new TextEncoder().encode('changed')),
        },
        ContentLength: 7,
        Metadata: { 'nexa-sha256': 'incorrect' },
      });
    const store = new S3PrivateObjectStore(config, {
      send,
      destroy: vi.fn(),
    } as unknown as S3Client);
    await store.put('safe/key', new TextEncoder().encode('original'));
    const command = send.mock.calls[0]?.[0] as unknown as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input.IfNoneMatch).toBe('*');
    expect(command.input.Metadata?.['nexa-sha256']).toMatch(/^[a-f0-9]{64}$/);
    await expect(store.get('safe/key')).rejects.toMatchObject({
      code: 'integrity_failure',
    });
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetObjectCommand);
  });

  it('makes ambiguous write retries immutable and idempotent', async () => {
    const bytes = new TextEncoder().encode('original');
    const sha256 =
      '0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5';
    const conflict = Object.assign(new Error('private provider detail'), {
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412 },
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout after commit'))
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        Body: { transformToByteArray: () => Promise.resolve(bytes) },
        ContentLength: bytes.byteLength,
        ContentType: 'text/plain',
        Metadata: { 'nexa-sha256': sha256 },
      })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        Body: { transformToByteArray: () => Promise.resolve(bytes) },
        ContentLength: bytes.byteLength,
        ContentType: 'text/plain',
        Metadata: { 'nexa-sha256': sha256 },
      });
    const store = new S3PrivateObjectStore(config, {
      send,
      destroy: vi.fn(),
    } as unknown as S3Client);

    await expect(
      store.put('safe/immutable', bytes, 'text/plain'),
    ).rejects.toMatchObject({ code: 'object_unavailable' });
    await expect(
      store.put('safe/immutable', bytes, 'text/plain'),
    ).resolves.toEqual({ byteLength: bytes.byteLength, sha256 });
    await expect(
      store.put(
        'safe/immutable',
        new TextEncoder().encode('different'),
        'text/plain',
      ),
    ).rejects.toMatchObject({ code: 'integrity_failure' });
  });

  it('bounds prefix cleanup and translates listing failures', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new Error('credentials leaked here'));
    const store = new S3PrivateObjectStore(config, {
      send,
      destroy: vi.fn(),
    } as unknown as S3Client);
    await expect(store.deletePrefix('safe/', 2)).rejects.toMatchObject({
      code: 'object_unavailable',
    });
    const command = send.mock.calls[0]?.[0] as unknown as ListObjectsV2Command;
    expect(command).toBeInstanceOf(ListObjectsV2Command);
    expect(command.input.MaxKeys).toBe(2);
  });
});

integration('S3-compatible private object storage', () => {
  const liveConfig: ObjectStorageConfig = {
    ...config,
    endpoint: integrationEndpoint ?? 'http://127.0.0.1:1',
    accessKeyId: 'nexa-local',
    secretAccessKey: 'change-this-local-secret',
    bucket: 'nexa-object-storage-test',
    createBucket: true,
    maxObjectBytes: 1024,
    cleanupPageSize: 10,
  };

  it('verifies a private bucket and preserves integrity metadata through cleanup', async () => {
    const store = new S3PrivateObjectStore(liveConfig);
    await store.verify();
    const bytes = new TextEncoder().encode('private attachment bytes');
    const stored = await store.put('quarantine/a/object', bytes, 'text/plain');
    expect(stored).toEqual({
      byteLength: bytes.byteLength,
      sha256:
        'ea7885de84f92ae983b5aa4386034bbfb09deb5882e17131cf35d9824effa41b',
    });
    const loaded = await store.get('quarantine/a/object');
    expect(loaded.bytes).toEqual(bytes);
    expect(loaded.sha256).toBe(stored.sha256);
    expect(await store.deletePrefix('quarantine/a/', 1)).toBe(1);
    await expect(store.get('quarantine/a/object')).rejects.toMatchObject({
      code: 'object_unavailable',
    });
  });
});

const config: ObjectStorageConfig = {
  endpoint: 'http://127.0.0.1:1',
  region: 'us-east-1',
  accessKeyId: 'test',
  secretAccessKey: 'test-secret',
  bucket: 'test-bucket',
  forcePathStyle: true,
  createBucket: false,
  maxObjectBytes: 16,
  operationTimeoutMs: 100,
  cleanupPageSize: 2,
};
