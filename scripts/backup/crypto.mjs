import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { once } from 'node:events';

const MAGIC = Buffer.from('NEXABK1\0');
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + NONCE_BYTES;

function deriveKey(operatorKey, salt) {
  if (!Buffer.isBuffer(operatorKey) || operatorKey.length < 32) {
    throw new Error('invalid_key_material');
  }
  return Buffer.from(
    hkdfSync(
      'sha256',
      operatorKey,
      salt,
      Buffer.from('NexaChat backup component v1'),
      32,
    ),
  );
}

async function writeChunk(destination, chunk) {
  if (chunk.length > 0 && !destination.write(chunk)) {
    await once(destination, 'drain');
  }
}

function finishDestination(destination) {
  if (destination.writableFinished) return Promise.resolve();
  if (destination.destroyed || destination.closed) {
    return Promise.reject(new Error('destination_closed_before_finish'));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      destination.off('finish', onFinish);
      destination.off('close', onClose);
      destination.off('error', onError);
    };
    const settle = (complete, value) => {
      cleanup();
      complete(value);
    };
    const onFinish = () => settle(resolve);
    const onClose = () => {
      if (destination.writableFinished || destination.writableEnded)
        settle(resolve);
      else settle(reject, new Error('destination_closed_before_finish'));
    };
    const onError = (error) => settle(reject, error);

    destination.once('finish', onFinish);
    destination.once('close', onClose);
    destination.once('error', onError);
    try {
      destination.end();
    } catch (error) {
      settle(reject, error);
    }
  });
}

export async function encryptStream(source, destination, operatorKey) {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(
    'aes-256-gcm',
    deriveKey(operatorKey, salt),
    nonce,
  );
  try {
    await writeChunk(destination, Buffer.concat([MAGIC, salt, nonce]));
    for await (const chunk of source) {
      await writeChunk(destination, cipher.update(chunk));
    }
    await writeChunk(destination, cipher.final());
    await writeChunk(destination, cipher.getAuthTag());
    await finishDestination(destination);
  } catch (error) {
    destination.destroy();
    throw error;
  }
}

export async function decryptStream(source, destination, operatorKey) {
  let buffered = Buffer.alloc(0);
  let decipher;
  try {
    for await (const input of source) {
      buffered = Buffer.concat([buffered, input]);
      if (!decipher && buffered.length >= HEADER_BYTES) {
        const magic = buffered.subarray(0, MAGIC.length);
        if (!magic.equals(MAGIC))
          throw new Error('unsupported_encryption_format');
        const salt = buffered.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
        const nonce = buffered.subarray(
          MAGIC.length + SALT_BYTES,
          HEADER_BYTES,
        );
        decipher = createDecipheriv(
          'aes-256-gcm',
          deriveKey(operatorKey, salt),
          nonce,
        );
        buffered = buffered.subarray(HEADER_BYTES);
      }
      if (decipher && buffered.length > TAG_BYTES) {
        const boundary = buffered.length - TAG_BYTES;
        await writeChunk(
          destination,
          decipher.update(buffered.subarray(0, boundary)),
        );
        buffered = Buffer.from(buffered.subarray(boundary));
      }
    }
    if (!decipher || buffered.length !== TAG_BYTES) {
      throw new Error('incomplete_encrypted_component');
    }
    decipher.setAuthTag(buffered);
    await writeChunk(destination, decipher.final());
    await finishDestination(destination);
  } catch (error) {
    destination.destroy();
    throw error;
  }
}
