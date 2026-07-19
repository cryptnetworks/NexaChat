import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { URLSearchParams } from 'node:url';
import {
  GetObjectCommand,
  GetObjectTaggingCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const MAGIC = Buffer.from('NEXAOBJ1\n');
const MAX_HEADER_BYTES = 1024 * 1024;

async function writeChunk(destination, chunk) {
  if (chunk.length > 0 && !destination.write(chunk))
    await once(destination, 'drain');
}

function frameLength(length) {
  const frame = Buffer.alloc(4);
  frame.writeUInt32BE(length);
  return frame;
}

export function createObjectClient(config) {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    maxAttempts: 1,
  });
}

export async function listAllObjects(client, bucket) {
  const objects = [];
  let continuationToken;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key)
        objects.push({ key: object.Key, size: Number(object.Size ?? 0) });
    }
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined;
  } while (continuationToken);
  objects.sort((left, right) => left.key.localeCompare(right.key));
  return objects;
}

export async function exportObjectArchive(destination, config) {
  const client = createObjectClient(config);
  const inventory = createHash('sha256');
  let count = 0;
  let bytes = 0;
  try {
    await writeChunk(destination, MAGIC);
    const objects = await listAllObjects(client, config.bucket);
    for (const listed of objects) {
      if (listed.size > config.maxObjectBytes)
        throw new Error('object_exceeds_backup_limit');
      const [response, tagging] = await Promise.all([
        client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: listed.key }),
        ),
        client.send(
          new GetObjectTaggingCommand({
            Bucket: config.bucket,
            Key: listed.key,
          }),
        ),
      ]);
      if (!response.Body) throw new Error('object_body_missing');
      const body = Buffer.from(await response.Body.transformToByteArray());
      if (body.length > config.maxObjectBytes)
        throw new Error('object_exceeds_backup_limit');
      const digest = createHash('sha256').update(body).digest();
      const metadata = Object.fromEntries(
        Object.entries(response.Metadata ?? {}).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
      const tags = (tagging.TagSet ?? [])
        .map(({ Key, Value }) => ({ key: Key, value: Value }))
        .sort((left, right) =>
          `${left.key}\0${left.value}`.localeCompare(
            `${right.key}\0${right.value}`,
          ),
        );
      const header = Buffer.from(
        JSON.stringify({
          key: listed.key,
          length: body.length,
          contentType: response.ContentType,
          contentDisposition: response.ContentDisposition,
          contentEncoding: response.ContentEncoding,
          cacheControl: response.CacheControl,
          metadata,
          tags,
        }),
      );
      if (header.length > MAX_HEADER_BYTES)
        throw new Error('object_metadata_too_large');
      await writeChunk(destination, frameLength(header.length));
      await writeChunk(destination, header);
      await writeChunk(destination, body);
      await writeChunk(destination, digest);
      inventory.update(header).update(digest);
      count += 1;
      bytes += body.length;
    }
    await writeChunk(destination, frameLength(0));
    destination.end();
    return { count, bytes, inventorySha256: inventory.digest('hex') };
  } catch (error) {
    destination.destroy();
    throw error;
  } finally {
    client.destroy();
  }
}

class ArchiveReader {
  constructor(source) {
    this.iterator = source[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
  }

  async read(length) {
    while (this.buffer.length < length) {
      const next = await this.iterator.next();
      if (next.done) throw new Error('incomplete_object_archive');
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
    const value = this.buffer.subarray(0, length);
    this.buffer = Buffer.from(this.buffer.subarray(length));
    return value;
  }

  async assertEnd() {
    if (this.buffer.length > 0) throw new Error('trailing_object_archive_data');
    const next = await this.iterator.next();
    if (!next.done) throw new Error('trailing_object_archive_data');
  }
}

function parseHeader(serialized, maxObjectBytes) {
  let value;
  try {
    value = JSON.parse(serialized.toString('utf8'));
  } catch {
    throw new Error('invalid_object_header');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.key !== 'string' ||
    value.key.length === 0 ||
    Buffer.byteLength(value.key) > 1024 ||
    !Number.isSafeInteger(value.length) ||
    value.length < 0 ||
    value.length > maxObjectBytes ||
    !value.metadata ||
    typeof value.metadata !== 'object' ||
    !Array.isArray(value.tags) ||
    Object.entries(value.metadata).length > 100 ||
    Object.entries(value.metadata).some(
      ([key, metadataValue]) =>
        !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(key) ||
        typeof metadataValue !== 'string' ||
        Buffer.byteLength(metadataValue) > 2048,
    ) ||
    value.tags.length > 50 ||
    value.tags.some(
      (tag) =>
        !tag ||
        typeof tag.key !== 'string' ||
        typeof tag.value !== 'string' ||
        tag.key.length === 0 ||
        Buffer.byteLength(tag.key) > 128 ||
        Buffer.byteLength(tag.value) > 256,
    )
  ) {
    throw new Error('invalid_object_header');
  }
  return value;
}

export async function consumeObjectArchive(source, config, restore = false) {
  const reader = new ArchiveReader(source);
  if (!(await reader.read(MAGIC.length)).equals(MAGIC)) {
    throw new Error('unsupported_object_archive');
  }
  const client = restore ? createObjectClient(config) : undefined;
  const inventory = createHash('sha256');
  let count = 0;
  let bytes = 0;
  try {
    while (true) {
      const headerLength = (await reader.read(4)).readUInt32BE();
      if (headerLength === 0) break;
      if (headerLength > MAX_HEADER_BYTES)
        throw new Error('object_metadata_too_large');
      const serialized = await reader.read(headerLength);
      const header = parseHeader(serialized, config.maxObjectBytes);
      const body = await reader.read(header.length);
      const expectedDigest = await reader.read(32);
      const digest = createHash('sha256').update(body).digest();
      if (!digest.equals(expectedDigest))
        throw new Error('object_integrity_mismatch');
      inventory.update(serialized).update(digest);
      if (client) {
        const tagging = new URLSearchParams(
          header.tags.map(({ key, value }) => [String(key), String(value)]),
        ).toString();
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: header.key,
            Body: body,
            ContentLength: body.length,
            ContentType: header.contentType,
            ContentDisposition: header.contentDisposition,
            ContentEncoding: header.contentEncoding,
            CacheControl: header.cacheControl,
            Metadata: header.metadata,
            Tagging: tagging || undefined,
          }),
        );
      }
      count += 1;
      bytes += body.length;
    }
    await reader.assertEnd();
    return { count, bytes, inventorySha256: inventory.digest('hex') };
  } catch (error) {
    source.destroy?.();
    throw error;
  } finally {
    client?.destroy();
  }
}
