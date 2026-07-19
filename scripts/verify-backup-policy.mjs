import { readFile, readdir } from 'node:fs/promises';

const failures = [];
const fail = (message) => failures.push(message);
const command = await readFile('scripts/backup/command.mjs', 'utf8');
const crypto = await readFile('scripts/backup/crypto.mjs', 'utf8');
const objectArchive = await readFile(
  'scripts/backup/object-archive.mjs',
  'utf8',
);
const compose = await readFile('compose.production.yml', 'utf8');
const dockerfile = await readFile('Dockerfile', 'utf8');
const workflow = await readFile('.github/workflows/backup-restore.yml', 'utf8');
const runbook = await readFile('docs/operations/backup-and-restore.md', 'utf8');
const migrations = (await readdir('apps/server/migrations'))
  .filter((file) => file.endsWith('.sql'))
  .sort();

if (!command.includes(`const CURRENT_SCHEMA_VERSION = ${migrations.length};`))
  fail('backup schema ceiling does not match the migration set');
if (!compose.includes(`NEXA_MAX_SCHEMA_VERSION: '${migrations.length}'`))
  fail('production backup schema ceiling does not match the migration set');
for (const requirement of [
  "NEXA_BACKUP_MODE !== 'quiesced'",
  "NEXA_RECOVERY_MODE !== 'empty-only'",
  "startsWith('.partial-')",
  'manifest_authentication_failed',
  'component_integrity_mismatch',
  'component_missing',
  'unsupported_backup_components',
  'migration_history_mismatch',
  'invalid_postgres_archive',
  'restore_revision_mismatch',
  'restore_database_not_empty',
  'restore_bucket_not_empty',
  'retentionDays',
  'incompleteHours',
]) {
  if (!command.includes(requirement))
    fail(`backup command lacks ${requirement}`);
}
for (const requirement of [
  'createCipheriv(',
  'createDecipheriv(',
  'hkdfSync(',
  'timingSafeEqual',
]) {
  if (!(crypto + command).includes(requirement))
    fail(`cryptographic control lacks ${requirement}`);
}
for (const requirement of [
  'GetObjectTaggingCommand',
  'PutObjectCommand',
  'object_integrity_mismatch',
]) {
  if (!objectArchive.includes(requirement))
    fail(`object archive lacks ${requirement}`);
}
for (const requirement of [
  'profiles: [operations]',
  'read_only: true',
  'cap_drop: [ALL]',
  'backup_encryption_key',
  'NEXA_BACKUP_DIR',
]) {
  if (!compose.includes(requirement))
    fail(`production profile lacks ${requirement}`);
}
if (!dockerfile.includes('AS backup-runtime'))
  fail('backup runtime target is missing');
if (!workflow.includes('schedule:'))
  fail('scheduled restore verification is missing');
for (const section of [
  'Authoritative data and consistency',
  'Recovery objectives',
  'Key loss and rotation',
  'Incomplete backup or interrupted restore',
  'Forward-only migrations',
  'Recovery order',
]) {
  if (!runbook.includes(section)) fail(`runbook lacks ${section}`);
}

if (failures.length) {
  for (const failure of failures)
    console.error(`backup_policy_error: ${failure}`);
  process.exit(1);
}
console.log(
  `Backup policy verified for ${migrations.length} migrations, authenticated encryption, complete manifests, retention, and fail-closed restore.`,
);
