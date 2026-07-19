# Encrypted backup and restore

This runbook supports the single-host production profile. It deliberately
refuses live, partial, and in-place recovery operations. Keep backup media and
key material on separately controlled storage; possession of both permits full
database and object access.

## Authoritative data and consistency

PostgreSQL is authoritative for accounts, credentials, sessions, communities,
memberships, categories, spaces, messages, authorization state, invitations,
versioned audit events, audit checkpoints, and migration history. Independently
exported audit heads remain on separately controlled append-only storage and
are compared after restore. The private object-storage bucket is
captured in full, including object bytes, content metadata, custom metadata,
and tags. Although attachment application flows are not connected in the
current release, including the bucket now prevents the operational procedure
from silently omitting it when those flows are enabled. Valkey contains
reconstructable coordination state and is not restored.

TLS certificates, Compose configuration, and the database, Valkey, object, and
backup credentials are operator-managed configuration, not backup payloads.
Back them up in the operator's secret-management system. Never place them next
to the encrypted data without an independent access boundary.

A supported backup is quiesced: stop the public edge and application, confirm
they remain stopped, then run the backup. The command also refuses a source
with application database connections. This prevents PostgreSQL references and
object state from moving independently during capture. Do not treat a storage
snapshot taken while the application is writable as a supported backup.

## Prepare the key and destination

Create `backup_encryption_key` in `NEXA_SECRET_DIR` from at least 32 random
bytes and set mode `0400` or `0440` for the runtime UID. Record a non-secret
identifier in `NEXA_BACKUP_KEY_ID`. Never use a human password, pass the key on
the command line, commit it, or print it. Set `NEXA_BACKUP_DIR` to an absolute,
mode-`0700` directory on encrypted storage owned by `NEXA_BACKUP_UID` and
`NEXA_BACKUP_GID`.

Each completed `backup-*` directory contains:

- `postgres.dump.enc`, an authenticated encrypted PostgreSQL custom archive;
- `objects.archive.enc`, an authenticated encrypted stream of objects and
  provider-neutral metadata;
- `manifest.json`, version, revision, schema history, counts, recovery order,
  key identifier, component sizes, and SHA-256 checksums; and
- `manifest.hmac`, authentication for the complete manifest.

Keys, credentials, object keys, message bodies, and provider errors are not
logged. Object keys and metadata exist only inside the encrypted component.
The manifest records counts, not content.

## Create and verify a backup

From the exact checked-out revision represented by `NEXA_IMAGE_REVISION`:

```sh
docker compose -f compose.production.yml stop edge server
export NEXA_BACKUP_MODE=quiesced
docker compose -f compose.production.yml --profile operations run --rm backup backup
unset NEXA_BACKUP_MODE
docker compose -f compose.production.yml --profile operations run --rm backup verify /backups/backup-YYYY-MM-DD...
docker compose -f compose.production.yml up -d --wait server edge
```

The command writes a `.partial-*` directory first and renames it only after
both encrypted components, checksums, the manifest, and its HMAC exist. Copy
only completed directories to remote backup storage. Verify again after the
copy. Treat any verification failure as an unusable backup and alert the
operator; never weaken checksum, authentication, schema, or completeness
checks to recover it.

Run this procedure at least daily and after a high-value data import. A
scheduled GitHub workflow exercises a disposable end-to-end restore, but it is
not a production backup scheduler.

## Retention, pruning, and capacity

Defaults retain at least the newest seven completed backups and remove a
completed backup only when it is both outside that count and older than 30
days. Incomplete directories older than 24 hours are eligible for removal.
Apply the policy only after a new backup verifies and an off-host copy is
confirmed:

```sh
docker compose -f compose.production.yml --profile operations run --rm backup prune
```

Set `NEXA_BACKUP_RETENTION_COUNT`, `NEXA_BACKUP_RETENTION_DAYS`, and
`NEXA_BACKUP_INCOMPLETE_HOURS` to stricter organizational policy. Capacity
planning must cover the retained encrypted PostgreSQL archives, all object
bytes for every retained generation, manifests, remote-copy staging, and 20%
free headroom. Alert before free space drops below the next full backup plus
that headroom. Pruning is not a substitute for an independently retained
off-host generation.

## Recovery objectives

The supported operating target is a recovery point no older than 24 hours and
a 30-minute recovery time for a backup whose encrypted components can be read
within 10 minutes on the supported host. Measure both after every material data
growth or storage change. If a disposable restore exceeds either assumption,
reduce the backup interval, improve storage throughput, or document a revised
objective before production use.

## Recovery order

1. Isolate the host from users and preserve the failed volumes for incident
   analysis. Select the newest backup that passes `verify` with its recorded
   key and software revision.
2. Check out or build the recorded application revision. A runtime may restore
   a schema no newer than its declared maximum; unknown manifest versions,
   migration histories, components, or keys fail before mutation.
3. Start only empty PostgreSQL and object-storage services. Do not run
   migrations or start the server first.
4. Set `NEXA_RECOVERY_MODE=empty-only` and run `backup restore`. The command
   preflights the authenticated manifest, encrypted components, internal
   object digests, schema ceiling, empty database, and empty bucket before it
   writes. It restores object bytes first, then PostgreSQL metadata.
5. Run the recorded revision's migration command. Forward upgrades run only
   after the matching backup schema exists.
6. Validate migration history and counts, perform authenticated functional
   reads for representative accounts, communities, memberships, spaces,
   messages, audit events, checkpoints, and objects. Recompute every restored
   audit hash and compare the latest independently retained head, then run
   readiness checks.
7. Rotate operational credentials as required, start the server and edge, and
   monitor error, dependency, object-integrity, audit-integrity, and
   authentication signals.

Example against an empty isolated deployment:

```sh
docker compose -f compose.production.yml up -d --wait postgres object-storage
docker compose -f compose.production.yml --profile operations run --rm backup verify /backups/backup-YYYY-MM-DD...
export NEXA_RECOVERY_MODE=empty-only
docker compose -f compose.production.yml --profile operations run --rm backup restore /backups/backup-YYYY-MM-DD...
unset NEXA_RECOVERY_MODE
docker compose -f compose.production.yml run --rm migrate
```

The recovery-mode flag does not permit replacement. Any public table or bucket
object causes refusal. Recreate the isolated empty volumes instead of adding a
destructive override.

Restore defaults to the exact recorded revision. After a documented migration
compatibility review, an operator may set
`NEXA_RECOVERY_ALLOW_COMPATIBLE_REVISION=reviewed` for a newer runtime whose
schema ceiling and migration checks accept the backup. Record that exception
in the recovery evidence and unset it immediately afterward.

## Forward-only migrations

Backups record every migration name and checksum plus the maximum applied
schema version. Restore with the recorded software revision first. A newer
runtime may accept an older supported schema, but migrations remain
forward-only: after migration, rollback means returning to a fresh empty
deployment and restoring the pre-migration backup with its older software.
Never restore a newer schema using older software or edit migration history in
a manifest. Adding a migration requires updating the backup schema ceiling and
passing the complete disposable restore test.

## Key loss and rotation

There is no recovery from loss of the only encryption key. Maintain two tested,
independently controlled key copies and include key custody in disaster drills.
For rotation, create a new random key and key identifier, create and verify a
new backup, copy it off host, and retain the old key until every backup encrypted
with it has expired. Do not rewrite an existing backup or replace its key ID.
Verification with the wrong key must fail at manifest authentication.

Database and object-storage credentials are not restored. Rotate them after a
credential-related incident and update file-backed secrets before starting the
application. Because session hashes are database data, decide during incident
response whether all restored sessions must be revoked before traffic resumes.

## Incomplete backup or interrupted restore

A `.partial-*` directory, absent component, checksum mismatch, invalid HMAC,
authentication failure, corrupt object frame, or unsupported schema is not a
backup. Preserve enough evidence for diagnosis, create a new backup, and let
the retention command remove old incomplete directories only after the
configured delay.

If restore is interrupted, keep traffic disabled. Do not resume into the
partially written stores. Preserve logs with stable error codes, discard only
the isolated recovery volumes after confirming their exact project, recreate
empty stores, re-run `verify`, and restart recovery from step 3. If PostgreSQL
succeeds but object validation fails, or vice versa, the deployment is still
unservable and must be recreated empty.

After any recovery, record the backup ID, key ID, software revision, schema
version, start and end time, verification evidence, rotations performed, and
the operator who approved return to service.
