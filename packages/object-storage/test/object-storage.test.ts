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
  type ObjectStorageObserver,
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
    expect(command.input.Metadata?.['nexa-sha256']).toMatch(/^[a-f0-9]{64}$/);
    await expect(store.get('safe/key')).rejects.toMatchObject({
      code: 'integrity_failure',
    });
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetObjectCommand);
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

describe('object-storage observer', () => {
  it('cannot change a successful write or close when the observer throws', async () => {
    const send = vi.fn().mockResolvedValue({});
    const destroy = vi.fn();
    const observer = {
      event: vi.fn<ObjectStorageObserver['event']>(() => {
        throw new Error('telemetry unavailable');
      }),
    };
    const store = new S3PrivateObjectStore(
      config,
      { send, destroy } as unknown as S3Client,
      observer,
    );
    const bytes = new TextEncoder().encode('private');

    await expect(store.put('private/key', bytes)).resolves.toEqual({
      byteLength: bytes.byteLength,
      sha256:
        '715dc8493c36579a5b116995100f635e3572fdf8703e708ef1a08d943b36774e',
    });
    expect(() => {
      store.close();
    }).not.toThrow();

    expect(send).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(observer.event).toHaveBeenCalledTimes(2);
  });

  it('emits safe success and failure outcomes without private operation data', async () => {
    const key = 'private/key';
    const content = 'private attachment content';
    const providerMessage = 'private provider response detail';
    const privateConfig: ObjectStorageConfig = {
      ...config,
      endpoint: 'https://private-storage.example.test',
      accessKeyId: 'private-access-key',
      secretAccessKey: 'private-secret-key',
      bucket: 'private-bucket',
      maxObjectBytes: 128,
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error(providerMessage));
    const observer = { event: vi.fn<ObjectStorageObserver['event']>() };
    const store = new S3PrivateObjectStore(
      privateConfig,
      { send, destroy: vi.fn() } as unknown as S3Client,
      observer,
    );

    await expect(
      store.put(key, new TextEncoder().encode(content)),
    ).resolves.toMatchObject({ byteLength: content.length });
    await expect(store.get(key)).rejects.toMatchObject({
      code: 'object_unavailable',
    });

    expect(
      observer.event.mock.calls.map(([operation, outcome]) => [
        operation,
        outcome,
      ]),
    ).toEqual([
      ['put', 'success'],
      ['get', 'failure'],
    ]);
    for (const call of observer.event.mock.calls) {
      expect(call[2]).toBeTypeOf('number');
      expect(call[2]).toBeGreaterThanOrEqual(0);
    }
    const payload = JSON.stringify(observer.event.mock.calls);
    for (const secret of [
      key,
      content,
      providerMessage,
      privateConfig.endpoint,
      privateConfig.accessKeyId,
      privateConfig.secretAccessKey,
      privateConfig.bucket,
    ])
      expect(payload).not.toContain(secret);
  });

  it('reports failed verification and write outcomes with durations', async () => {
    const providerMessage = 'private failed provider operation';
    const send = vi.fn().mockRejectedValue(new Error(providerMessage));
    const observer = { event: vi.fn<ObjectStorageObserver['event']>() };
    const store = new S3PrivateObjectStore(
      config,
      { send, destroy: vi.fn() } as unknown as S3Client,
      observer,
    );

    await expect(store.verify()).rejects.toMatchObject({
      code: 'object_unavailable',
    });
    await expect(
      store.put('private/key', new TextEncoder().encode('private')),
    ).rejects.toMatchObject({ code: 'object_unavailable' });

    expect(observer.event).toHaveBeenNthCalledWith(
      1,
      'connect',
      'failure',
      expect.any(Number),
    );
    expect(observer.event).toHaveBeenNthCalledWith(
      2,
      'put',
      'failure',
      expect.any(Number),
    );
    for (const call of observer.event.mock.calls)
      expect(call[2]).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(observer.event.mock.calls)).not.toContain(
      providerMessage,
    );
  });

  it.each(['AbortError', 'TimeoutError'])(
    'classifies an S3 %s as a bounded timeout',
    async (name) => {
      const providerMessage = 'private timeout provider detail';
      const error = Object.assign(new Error(providerMessage), { name });
      const send = vi.fn().mockRejectedValue(error);
      const observer = { event: vi.fn<ObjectStorageObserver['event']>() };
      const store = new S3PrivateObjectStore(
        config,
        { send, destroy: vi.fn() } as unknown as S3Client,
        observer,
      );

      await expect(
        store.put('private/key', new TextEncoder().encode('private')),
      ).rejects.toMatchObject({ code: 'object_unavailable' });

      expect(observer.event).toHaveBeenCalledWith(
        'timeout',
        'failure',
        expect.any(Number),
      );
      expect(JSON.stringify(observer.event.mock.calls)).not.toContain(
        providerMessage,
      );
    },
  );
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
