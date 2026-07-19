#!/usr/bin/env node
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { decryptStream, encryptStream } from './crypto.mjs';
import {
  consumeObjectArchive,
  createObjectClient,
  exportObjectArchive,
  listAllObjects,
} from './object-archive.mjs';

const MANIFEST_VERSION = 1;
const CURRENT_SCHEMA_VERSION = 10;
const COMPONENTS = ['postgres.dump.enc', 'objects.archive.enc'];
const TABLES = [
  'accounts',
  'communities',
  'memberships',
  'categories',
  'spaces',
  'messages',
  'sessions',
  'authorization_roles',
  'authorization_role_assignments',
  'authorization_decisions',
  'community_ownership_versions',
  'invitations',
  'audit_events',
];

function fail(code) {
  throw new Error(code);
}

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

async function secret(path) {
  if (!path) fail('secret_file_required');
  const value = await readFile(path);
  return value.at(-1) === 10 ? value.subarray(0, -1) : value;
}

function configuration() {
  const backupRoot = resolve(process.env.NEXA_BACKUP_DIR ?? '/backups');
  const config = {
    backupRoot,
    keyFile:
      process.env.NEXA_BACKUP_KEY_FILE ?? '/run/secrets/backup_encryption_key',
    databaseUrlFile:
      process.env.DATABASE_URL_FILE ?? '/run/secrets/database_url',
    appVersion: process.env.NEXA_IMAGE_VERSION ?? 'unknown',
    appRevision: process.env.NEXA_IMAGE_REVISION ?? 'unknown',
    keyId: process.env.NEXA_BACKUP_KEY_ID ?? 'operator-managed',
    maxSchemaVersion: Number(
      process.env.NEXA_MAX_SCHEMA_VERSION ?? CURRENT_SCHEMA_VERSION,
    ),
    retentionDays: Number(process.env.NEXA_BACKUP_RETENTION_DAYS ?? 30),
    retentionCount: Number(process.env.NEXA_BACKUP_RETENTION_COUNT ?? 7),
    incompleteHours: Number(process.env.NEXA_BACKUP_INCOMPLETE_HOURS ?? 24),
    object: {
      endpoint: process.env.S3_ENDPOINT ?? 'http://object-storage:8333',
      region: process.env.S3_REGION ?? 'us-east-1',
      bucket: process.env.S3_BUCKET ?? 'nexa-attachments',
      accessKeyFile:
        process.env.S3_ACCESS_KEY_FILE ?? '/run/secrets/s3_access_key',
      secretKeyFile:
        process.env.S3_SECRET_KEY_FILE ?? '/run/secrets/s3_secret_key',
      maxObjectBytes: Number(
        process.env.NEXA_BACKUP_MAX_OBJECT_BYTES ?? 67_108_864,
      ),
    },
  };
  if (
    !/^[A-Za-z0-9._-]{1,128}$/u.test(config.keyId) ||
    !Number.isSafeInteger(config.maxSchemaVersion) ||
    config.maxSchemaVersion < 1 ||
    !Number.isSafeInteger(config.retentionDays) ||
    config.retentionDays < 0 ||
    !Number.isSafeInteger(config.retentionCount) ||
    config.retentionCount < 1 ||
    !Number.isSafeInteger(config.incompleteHours) ||
    config.incompleteHours < 1 ||
    !Number.isSafeInteger(config.object.maxObjectBytes) ||
    config.object.maxObjectBytes < 1
  ) {
    fail('invalid_backup_configuration');
  }
  return config;
}

async function runtime(config) {
  const [operatorKey, databaseUrl, accessKey, secretKey] = await Promise.all([
    secret(config.keyFile),
    secret(config.databaseUrlFile),
    secret(config.object.accessKeyFile),
    secret(config.object.secretKeyFile),
  ]);
  if (operatorKey.length < 32) fail('invalid_key_material');
  return {
    operatorKey,
    databaseUrl: databaseUrl.toString('utf8'),
    object: {
      ...config.object,
      accessKey: accessKey.toString('utf8'),
      secretKey: secretKey.toString('utf8'),
    },
  };
}

async function hashFile(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

function databaseProcess(command, databaseUrl, arguments_) {
  const parsed = new URL(databaseUrl);
  const password = decodeURIComponent(parsed.password);
  parsed.password = '';
  return spawn(command, [...arguments_, '--dbname', parsed.toString()], {
    env: { ...process.env, PGPASSWORD: password },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function successful(child, code, consumeStdout = false) {
  if (consumeStdout) child.stdout.resume();
  child.stderr.resume();
  const [exitCode] = await onceClose(child);
  if (exitCode !== 0) fail(code);
}

function onceClose(child) {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (...arguments_) => resolvePromise(arguments_));
  });
}

async function databaseState(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const migrations = await pool.query(
      'SELECT version, name, checksum FROM nexa_schema_migrations ORDER BY version',
    );
    const counts = {};
    for (const table of TABLES) {
      const result = await pool.query(
        `SELECT count(*)::integer AS count FROM ${table}`,
      );
      counts[table] = result.rows[0].count;
    }
    const active = await pool.query(
      `SELECT count(*)::integer AS count FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND backend_type = 'client backend'`,
    );
    return {
      migrations: migrations.rows,
      counts,
      activeClients: active.rows[0].count,
    };
  } finally {
    await pool.end();
  }
}

async function assertDatabaseEmpty(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `SELECT count(*)::integer AS count FROM pg_tables
       WHERE schemaname = 'public'`,
    );
    if (result.rows[0].count !== 0) fail('restore_database_not_empty');
  } finally {
    await pool.end();
  }
}

function canonicalManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function manifestMac(serialized, operatorKey) {
  return createHmac('sha256', operatorKey).update(serialized).digest('hex');
}

async function backup(config, values) {
  if (process.env.NEXA_BACKUP_MODE !== 'quiesced')
    fail('backup_requires_quiesced_mode');
  await mkdir(config.backupRoot, { recursive: true, mode: 0o700 });
  await chmod(config.backupRoot, 0o700);
  const timestamp = new Date().toISOString();
  const identifier = `${timestamp.replaceAll(/[:.]/g, '-')}-${randomUUID()}`;
  const partial = join(config.backupRoot, `.partial-${identifier}`);
  const completed = join(config.backupRoot, `backup-${identifier}`);
  await mkdir(partial, { mode: 0o700 });
  await writeFile(join(partial, 'INCOMPLETE'), 'backup not complete\n', {
    mode: 0o600,
  });
  const before = await databaseState(values.databaseUrl);
  if (before.activeClients !== 0) fail('application_connections_active');
  const schemaVersion = before.migrations.at(-1)?.version ?? 0;
  if (schemaVersion !== CURRENT_SCHEMA_VERSION)
    fail('unsupported_source_schema');

  const dump = databaseProcess('pg_dump', values.databaseUrl, [
    '--format=custom',
    '--compress=9',
    '--no-owner',
    '--no-privileges',
  ]);
  const databasePath = join(partial, COMPONENTS[0]);
  const encryptDatabase = encryptStream(
    dump.stdout,
    createWriteStream(databasePath, { mode: 0o600 }),
    values.operatorKey,
  );
  await Promise.all([
    encryptDatabase,
    successful(dump, 'postgres_backup_failed'),
  ]);

  const objectPath = join(partial, COMPONENTS[1]);
  const objectSource = new PassThrough();
  const [objectState] = await Promise.all([
    exportObjectArchive(objectSource, values.object),
    encryptStream(
      objectSource,
      createWriteStream(objectPath, { mode: 0o600 }),
      values.operatorKey,
    ),
  ]);
  const after = await databaseState(values.databaseUrl);
  if (after.activeClients !== 0) fail('application_connections_active');
  if (
    JSON.stringify(before.migrations) !== JSON.stringify(after.migrations) ||
    JSON.stringify(before.counts) !== JSON.stringify(after.counts)
  ) {
    fail('database_changed_during_backup');
  }

  const [databaseComponent, objectComponent] = await Promise.all([
    hashFile(databasePath),
    hashFile(objectPath),
  ]);
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    backupId: identifier,
    createdAt: timestamp,
    application: { version: config.appVersion, revision: config.appRevision },
    schema: { version: schemaVersion, migrations: before.migrations },
    consistency: {
      mode: 'quiesced',
      recoveryOrder: [
        'object-storage',
        'postgresql',
        'migrations',
        'validation',
      ],
    },
    stores: {
      postgresql: { tableCounts: before.counts },
      objectStorage: objectState,
    },
    encryption: {
      algorithm: 'AES-256-GCM',
      keyDerivation: 'HKDF-SHA-256',
      keyId: config.keyId,
    },
    components: {
      [COMPONENTS[0]]: databaseComponent,
      [COMPONENTS[1]]: objectComponent,
    },
  };
  const serialized = canonicalManifest(manifest);
  await writeFile(join(partial, 'manifest.json'), serialized, { mode: 0o600 });
  await writeFile(
    join(partial, 'manifest.hmac'),
    `${manifestMac(serialized, values.operatorKey)}\n`,
    { mode: 0o600 },
  );
  await rm(join(partial, 'INCOMPLETE'));
  await rename(partial, completed);
  log('backup.complete', {
    backupId: identifier,
    schemaVersion,
    objectCount: objectState.count,
  });
  return completed;
}

async function loadAndVerify(config, values, directory) {
  let backupDirectory;
  let backupRoot;
  try {
    [backupDirectory, backupRoot] = await Promise.all([
      realpath(resolve(directory)),
      realpath(config.backupRoot),
    ]);
  } catch {
    fail('backup_component_missing');
  }
  if (!backupDirectory.startsWith(`${backupRoot}/`))
    fail('backup_path_outside_root');
  if (basename(backupDirectory).startsWith('.partial-'))
    fail('incomplete_backup');
  if (!basename(backupDirectory).startsWith('backup-'))
    fail('invalid_backup_directory');
  const manifestPath = join(backupDirectory, 'manifest.json');
  const manifestMacPath = join(backupDirectory, 'manifest.hmac');
  try {
    const [manifestDetails, macDetails] = await Promise.all([
      lstat(manifestPath),
      lstat(manifestMacPath),
    ]);
    if (
      !manifestDetails.isFile() ||
      manifestDetails.size > 1024 * 1024 ||
      !macDetails.isFile() ||
      macDetails.size > 128
    ) {
      fail('invalid_manifest_files');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_manifest_files')
      throw error;
    fail('backup_component_missing');
  }
  const [serialized, suppliedMac] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(manifestMacPath, 'utf8'),
  ]);
  const expectedMac = manifestMac(serialized, values.operatorKey);
  const supplied = suppliedMac.trim();
  if (
    !/^[0-9a-f]{64}$/u.test(supplied) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expectedMac))
  ) {
    fail('manifest_authentication_failed');
  }
  let manifest;
  try {
    manifest = JSON.parse(serialized);
  } catch {
    fail('invalid_manifest');
  }
  if (
    manifest.manifestVersion !== MANIFEST_VERSION ||
    !Number.isSafeInteger(manifest.schema?.version) ||
    manifest.schema.version < 1 ||
    manifest.schema.version > config.maxSchemaVersion ||
    manifest.consistency?.mode !== 'quiesced'
  ) {
    fail('unsupported_manifest');
  }
  const componentNames = Object.keys(manifest.components ?? {}).sort();
  if (
    JSON.stringify(componentNames) !== JSON.stringify([...COMPONENTS].sort())
  ) {
    fail('unsupported_backup_components');
  }
  if (
    !Array.isArray(manifest.schema.migrations) ||
    manifest.schema.migrations.length !== manifest.schema.version ||
    manifest.schema.migrations.some(
      (migration, index) =>
        migration.version !== index + 1 ||
        typeof migration.name !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(migration.checksum ?? ''),
    )
  ) {
    fail('migration_history_mismatch');
  }
  for (const component of COMPONENTS) {
    const componentPath = join(backupDirectory, component);
    try {
      const details = await lstat(componentPath);
      if (!details.isFile()) fail('invalid_component_file');
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid_component_file')
        throw error;
      fail('component_missing');
    }
    const actual = await hashFile(componentPath);
    const expected = manifest.components?.[component];
    if (
      !expected ||
      actual.sha256 !== expected.sha256 ||
      actual.bytes !== expected.bytes
    ) {
      fail('component_integrity_mismatch');
    }
  }
  const archiveValidation = spawn('pg_restore', ['--list'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await Promise.all([
    decryptStream(
      createReadStream(join(backupDirectory, COMPONENTS[0])),
      archiveValidation.stdin,
      values.operatorKey,
    ),
    successful(archiveValidation, 'invalid_postgres_archive', true),
  ]);
  const objectPlaintext = new PassThrough();
  const [objectState] = await Promise.all([
    consumeObjectArchive(objectPlaintext, values.object),
    decryptStream(
      createReadStream(join(backupDirectory, COMPONENTS[1])),
      objectPlaintext,
      values.operatorKey,
    ),
  ]);
  if (
    JSON.stringify(objectState) !==
    JSON.stringify(manifest.stores.objectStorage)
  ) {
    fail('object_inventory_mismatch');
  }
  log('backup.verified', {
    backupId: manifest.backupId,
    schemaVersion: manifest.schema.version,
    objectCount: objectState.count,
  });
  return { backupDirectory, manifest };
}

async function restore(config, values, directory) {
  if (process.env.NEXA_RECOVERY_MODE !== 'empty-only')
    fail('restore_requires_recovery_mode');
  const verified = await loadAndVerify(config, values, directory);
  if (
    verified.manifest.application?.revision !== config.appRevision &&
    process.env.NEXA_RECOVERY_ALLOW_COMPATIBLE_REVISION !== 'reviewed'
  ) {
    fail('restore_revision_mismatch');
  }
  await assertDatabaseEmpty(values.databaseUrl);
  const objectClient = createObjectClient(values.object);
  try {
    if (
      (await listAllObjects(objectClient, values.object.bucket)).length !== 0
    ) {
      fail('restore_bucket_not_empty');
    }
  } finally {
    objectClient.destroy();
  }

  const objectPlaintext = new PassThrough();
  const restoreObjects = consumeObjectArchive(
    objectPlaintext,
    values.object,
    true,
  );
  await Promise.all([
    restoreObjects,
    decryptStream(
      createReadStream(join(verified.backupDirectory, COMPONENTS[1])),
      objectPlaintext,
      values.operatorKey,
    ),
  ]);

  const restoreProcess = databaseProcess('pg_restore', values.databaseUrl, [
    '--exit-on-error',
    '--no-owner',
    '--no-privileges',
  ]);
  const restoreDatabase = decryptStream(
    createReadStream(join(verified.backupDirectory, COMPONENTS[0])),
    restoreProcess.stdin,
    values.operatorKey,
  );
  await Promise.all([
    restoreDatabase,
    successful(restoreProcess, 'postgres_restore_failed', true),
  ]);
  const restored = await databaseState(values.databaseUrl);
  if (
    JSON.stringify(restored.counts) !==
      JSON.stringify(verified.manifest.stores.postgresql.tableCounts) ||
    JSON.stringify(restored.migrations) !==
      JSON.stringify(verified.manifest.schema.migrations)
  ) {
    fail('restored_database_mismatch');
  }
  const restoredObjectState = await exportObjectArchive(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    values.object,
  );
  if (
    JSON.stringify(restoredObjectState) !==
    JSON.stringify(verified.manifest.stores.objectStorage)
  ) {
    fail('restored_object_inventory_mismatch');
  }
  log('restore.complete', {
    backupId: verified.manifest.backupId,
    schemaVersion: verified.manifest.schema.version,
  });
}

async function prune(config, values) {
  const now = Date.now();
  const entries = await readdir(config.backupRoot, { withFileTypes: true });
  const completed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(config.backupRoot, entry.name);
    const details = await stat(path);
    if (entry.name.startsWith('.partial-')) {
      if (now - details.mtimeMs > config.incompleteHours * 3_600_000)
        await rm(path, { recursive: true });
    } else if (entry.name.startsWith('backup-')) {
      completed.push({ path, mtimeMs: details.mtimeMs });
    }
  }
  completed.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of completed) {
    await loadAndVerify(config, values, candidate.path);
  }
  let removed = 0;
  for (const [index, candidate] of completed.entries()) {
    const expired = now - candidate.mtimeMs > config.retentionDays * 86_400_000;
    if (index >= config.retentionCount && expired) {
      await rm(candidate.path, { recursive: true });
      removed += 1;
    }
  }
  log('backup.prune.complete', {
    removed,
    retained: completed.length - removed,
  });
}

async function main() {
  const [command, directory] = process.argv.slice(2);
  const config = configuration();
  if (!['backup', 'verify', 'restore', 'prune'].includes(command))
    fail('unsupported_command');
  const values = await runtime(config);
  if (command === 'prune') return prune(config, values);
  if (command === 'backup') {
    await backup(config, values);
  } else {
    if (!directory) fail('backup_directory_required');
    if (command === 'verify') await loadAndVerify(config, values, directory);
    else await restore(config, values, directory);
  }
}

try {
  await main();
} catch (error) {
  const code =
    error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : 'backup_operation_failed';
  process.stderr.write(`${JSON.stringify({ event: 'backup.failed', code })}\n`);
  process.exitCode = 1;
}
