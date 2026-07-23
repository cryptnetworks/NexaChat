# Supported upgrades and recovery boundaries

`release/upgrade-policy.json` is the machine-readable authority for direct
Nexa Chat upgrades. It is versioned with the application and validated against
the root semantic version, every contiguous SQL migration, the compiled
PostgreSQL schema constant, and the runtime configuration schema. A release
candidate fails if any of those surfaces drift.
The [support and compatibility policy](support-compatibility.md) is authoritative
for client/server pairs, rolling-deployment support windows, and environment
floors; an upgrade path does not by itself broaden that matrix.

The current repository version is the first declared `0.1.0` line; there is no
earlier production release. Consequently, current executable paths are a clean
install and same-version recovery rehearsal. Listing `0.1.0` as a source does
not invent a published predecessor. When a newer target is prepared, release
automation updates only `targetVersion`; maintainers must explicitly review the
retained source versions, channel transitions, schema range, configuration
contract, and rollback evidence. Unsupported skipped versions must first be
upgraded to a listed intermediate release.

## Trust and authorization boundaries

An upgrade is an operator-authorized maintenance action, never a user or web
request. The public application has no endpoint that runs migrations, selects a
release, reads backup identifiers, changes channels, or invokes these tools.
Only an authenticated infrastructure operator with database and deployment
authority may enter maintenance mode and execute a reviewed candidate.

The read-only database preflight uses the normal production configuration,
opens a repeatable-read transaction, takes the same PostgreSQL advisory lock as
the migrator, and validates the complete applied name/checksum sequence. It
returns only schema numbers, pending versions, and a migration-set digest. It
does not print the database URL or provider errors:

```sh
npm run release:upgrade:database
```

That plan is a bounded snapshot, not authorization to migrate. The migrator
takes the lock again inside its write transaction and revalidates contiguous
history and every checksum at commit time. Concurrent startup applies each
migration once. Modified, missing, noncontiguous, or ahead history fails closed.

## Preflight

Generate operational evidence from authoritative probes, store it outside the
release bundle with restricted access, and evaluate it before changing state:

```sh
npm run release:upgrade -- policy
npm run release:upgrade -- preflight --evidence=/protected/preflight.json
```

Evidence is strict JSON capped at 32 KiB. Unknown fields, unsafe identifiers,
invalid timestamps, unsupported versions/channels/configuration, or malformed
commit IDs are validation failures. A semantic rejection returns a sorted list
of stable failure codes and exit status 2. Output contains only target version,
check count, codes, and a SHA-256 plan ID; backup and restore-test identifiers
are not echoed.

Preflight requires:

- a detached-signature-verified artifact for the exact commit, version,
  channel, platform, and architecture;
- a supported source version/channel or a genuinely empty clean install;
- an advisory-locked database plan at or below schema 47 and configuration
  schema 1 with unknown settings rejected;
- for existing data, a backup no more than 24 hours old whose PostgreSQL and
  object data were actually restore-tested together under a bounded opaque ID;
- available space at least twice the estimated installer plus database growth;
- PostgreSQL ready, and optional object storage and coordination either ready
  or explicitly disabled;
- maintenance mode for schema change, every older application instance
  drained, and background jobs quiescent.

The JSON fixture under `tools/release/fixtures/upgrade` is synthetic test data,
not proof of a real backup, restore, capacity measurement, or production
upgrade. Operators must never mark a Boolean true without retaining its source
evidence.

## Execution and postflight

After an accepted preflight, retain its plan ID and exact evidence, stop writes,
run `npm run migrate` once, then deploy only the verified candidate. Mixed old
and new application versions are unsupported during schema changes. Valkey is
non-authoritative and may reconnect/repopulate; PostgreSQL and private object
storage must remain coordinated with the backup boundary.

Evaluate postflight evidence before leaving maintenance mode:

```sh
npm run release:upgrade -- postflight \
  --preflight-evidence=/protected/preflight.json \
  --evidence=/protected/postflight.json
```

The evaluator recomputes the accepted preflight plan ID and requires the
postflight record to name it, preventing evidence from a different proposed
upgrade from being attached accidentally. Required checks are exact
application/configuration/database versions,
`/health/ready`, migration-history verification, repeat artifact verification,
HTTP and WebSocket authorization probes, audit integrity, background-job
recovery, object-storage behavior, coordination/fan-out behavior, no more than
1% failed representative requests, and retention of the rollback checkpoint.
Authorization probes must use dedicated synthetic accounts and private scopes;
logs and evidence contain no session tokens, content, addresses, storage keys,
or database credentials.

## Rollback and interruption

SQL migrations are forward-only and no down-migration command exists. A binary
rollback is permitted only if the prior binary declares compatibility with the
current schema and configuration. This initial policy makes no such
cross-version declaration. After any schema change, rollback means stop all
writers, preserve failure evidence, restore the verified PostgreSQL and object
storage checkpoint as one consistency boundary, deploy the prior verified
artifact, and rerun its readiness and authorization checks.

If migration fails, its transaction rolls back and maintenance remains active.
If the process, network, or host stops after commit, do not restore blindly:
rerun the read-only plan to distinguish pre-commit rollback from committed
schema, then either resume the idempotent deployment or follow the restore
procedure. Never delete migration history, edit a checksum, apply SQL manually,
or start an older binary merely to test whether it works.

Backups, restore tests, platform upgrades, and recovery timing still require
retained release-candidate evidence. The policy and unit fixtures prove
deterministic decision behavior; they do not prove a production upgrade or
rollback has occurred.
