import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { decryptStream, encryptStream } from './crypto.mjs';

async function transform(input, operation, key) {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk));
  await operation(Readable.from([input]), output, key);
  return Buffer.concat(chunks);
}

class SynchronousFinishDestination extends EventEmitter {
  chunks = [];

  write(chunk) {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end() {
    this.emit('finish');
  }

  destroy(error) {
    if (error) this.emit('error', error);
  }

  contents() {
    return Buffer.concat(this.chunks);
  }
}

class PrematureCloseDestination extends EventEmitter {
  write() {
    return true;
  }

  end() {
    this.emit('close');
  }

  destroy() {}
}

async function transformWithSynchronousFinish(input, operation, key) {
  const output = new SynchronousFinishDestination();
  await operation(Readable.from([input]), output, key);
  return output.contents();
}

describe('backup component encryption', () => {
  it('round trips bounded binary input without plaintext headers', async () => {
    const key = randomBytes(32);
    const plaintext = Buffer.concat([
      Buffer.from('private backup contents'),
      randomBytes(256 * 1024),
    ]);
    const encrypted = await transform(plaintext, encryptStream, key);
    expect(encrypted.subarray(0, plaintext.length)).not.toEqual(plaintext);
    await expect(transform(encrypted, decryptStream, key)).resolves.toEqual(
      plaintext,
    );
  });

  it('observes destinations that finish synchronously during end', async () => {
    const key = randomBytes(32);
    const plaintext = Buffer.from('synchronous destination completion');
    const encrypted = await transformWithSynchronousFinish(
      plaintext,
      encryptStream,
      key,
    );

    await expect(
      transformWithSynchronousFinish(encrypted, decryptStream, key),
    ).resolves.toEqual(plaintext);
  });

  it('rejects when encryption or decryption destinations close prematurely', async () => {
    const key = randomBytes(32);
    const plaintext = Buffer.from('premature destination closure');

    await expect(
      encryptStream(
        Readable.from([plaintext]),
        new PrematureCloseDestination(),
        key,
      ),
    ).rejects.toThrow('destination_closed_before_finish');

    const encrypted = await transform(plaintext, encryptStream, key);
    await expect(
      decryptStream(
        Readable.from([encrypted]),
        new PrematureCloseDestination(),
        key,
      ),
    ).rejects.toThrow('destination_closed_before_finish');
  });

  it('rejects altered ciphertext and the wrong key', async () => {
    const key = randomBytes(32);
    const encrypted = await transform(
      Buffer.from('authenticated component'),
      encryptStream,
      key,
    );
    encrypted[40] ^= 1;
    await expect(transform(encrypted, decryptStream, key)).rejects.toThrow();
    const valid = await transform(
      Buffer.from('authenticated component'),
      encryptStream,
      key,
    );
    await expect(
      transform(valid, decryptStream, randomBytes(32)),
    ).rejects.toThrow();
  });

  it('rejects short key material and truncated components', async () => {
    await expect(
      transform(Buffer.from('content'), encryptStream, randomBytes(31)),
    ).rejects.toThrow('invalid_key_material');
    await expect(
      transform(Buffer.from('NEXABK1\0'), decryptStream, randomBytes(32)),
    ).rejects.toThrow('incomplete_encrypted_component');
  });
});
