import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { ConfigurationError } from './config.js';

const maximumSecretBytes = 65_536;
const composeSecretsDirectory = '/run/secrets';

const fileSources = [
  ['DATABASE_URL', 'DATABASE_URL_FILE'],
  ['REDIS_URL', 'REDIS_URL_FILE'],
  ['S3_ACCESS_KEY', 'S3_ACCESS_KEY_FILE'],
  ['S3_SECRET_KEY', 'S3_SECRET_KEY_FILE'],
] as const;

export function loadFileBackedSecrets(
  input: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...input };
  for (const [targetKey, fileKey] of fileSources) {
    const directValue = env[targetKey];
    const path = env[fileKey];
    if (directValue !== undefined && path !== undefined)
      fail(fileKey, `cannot be combined with ${targetKey}`);
    if (path === undefined) continue;
    env[targetKey] = readSecret(path, fileKey);
    Reflect.deleteProperty(env, fileKey);
  }
  return env;
}

function readSecret(path: string, key: string): string {
  if (!path.trim() || path !== path.trim())
    fail(key, 'must identify a readable secret file');
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink())
      fail(key, 'must identify a regular non-symlink file');
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino)
      fail(key, 'secret file changed while it was being opened');
    validateSecretFilePermissions(path, stat.mode, stat.uid, key);
    if (stat.size < 1 || stat.size > maximumSecretBytes)
      fail(key, 'secret file must contain from 1 to 65536 bytes');
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength < 1 || bytes.byteLength > maximumSecretBytes)
      fail(key, 'secret file must contain from 1 to 65536 bytes');
    const value = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes)
      .replace(/(?:\r\n|\n)+$/u, '');
    if (!value.trim() || value.includes('\0') || /[\r\n]/u.test(value))
      fail(key, 'secret file must contain one non-empty text value');
    return value;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return fail(key, 'could not be read safely');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function validateSecretFilePermissions(
  path: string,
  mode: number,
  owner: number,
  key: string,
  effectiveUser = process.geteuid?.(),
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') return;
  const resolved = resolve(path);
  if (dirname(resolved) === composeSecretsDirectory) {
    if ((mode & 0o444) === 0 || (mode & 0o333) !== 0)
      fail(key, 'mounted secret file permissions are unsafe');
    return;
  }
  if (owner !== 0 && owner !== effectiveUser)
    fail(key, 'secret file must be owned by root or the current user');
  if ((mode & 0o400) === 0)
    fail(key, 'secret file owner must have read access');
  if ((mode & 0o177) !== 0)
    fail(key, 'secret file must not grant group or other access');
}

function fail(key: string, reason: string): never {
  throw new ConfigurationError(key, reason);
}
