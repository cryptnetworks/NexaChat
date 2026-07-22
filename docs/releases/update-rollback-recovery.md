# Desktop update, rollback, and recovery

Nexa Chat does not enable an automatic runtime updater yet. The desktop shell
has no update capability, remote update endpoint, filesystem command, or
signing credential. `release/update-policy.json` and the sandboxed release
harness define and test the security and recovery contract that a future
repository-approved Tauri updater and platform installer must satisfy before
that capability can be enabled.

This distinction matters: passing the harness is signed **test** evidence, not
evidence that a published package, production update service, Apple or
Microsoft identity, notarization, or operating-system installer has passed.

## Current supported paths

The repository is still on its first declared `0.1.0` line and has no earlier
production release. The only current path is `0.1.0` to `0.1.0` in
`same-version-recovery` mode. It permits recovery testing without inventing an
upgrade from an unpublished version. When a later version is prepared,
maintainers must explicitly add each source-to-target path after completing its
data, package, and rollback rehearsal. Merely changing `targetVersion` is not
enough; the policy loader fails if paths or release-channel rules drift from
the upgrade policy.

The required target matrix is:

| Platform | Architecture | Candidate package forms       |
| -------- | ------------ | ----------------------------- |
| Linux    | x64          | AppImage, deb, rpm, or tar.gz |
| macOS    | arm64        | dmg or app.tar.gz             |
| macOS    | x64          | dmg or app.tar.gz             |
| Windows  | x64          | msi or nsis.zip               |

Stable targets accept only stable sources. Beta targets accept stable or beta
sources. Nightly is isolated from both and accepts only nightly. An ordinary
update never downgrades. A rollback is a separate local recovery operation and
is available only when the exact forward path was supported and an intact
prior slot remains.

## Update trust boundary

The verifier receives metadata, artifact bytes, and an externally trusted
Ed25519 public key. It performs no network request and does not trust a key
bundled beside the download. A future downloader must enforce HTTPS, bounded
redirects and timeouts, an origin allowlist, proxy policy, and streaming size
limits before passing bytes to this verifier.

Metadata is canonical, strict JSON no larger than 32 KiB. Unknown fields,
unsafe identifiers, non-semantic versions, unsupported targets, abbreviated
commits, channel crossover, unsupported paths, downgrades, and unexpected
identity all fail closed. The detached signature binds:

- source and target version, channel, and local-data schema;
- exact target platform and architecture;
- exact full source commit;
- bounded artifact filename, byte length, and SHA-256;
- issue time and unique update identifier.

Verification uses a public key supplied outside the update envelope, checks
its derived key ID, requires the expected `test` or `production` environment,
and verifies the Ed25519 signature before applying policy decisions. Artifact
length and SHA-256 are then checked before any staging write. A test key can
never satisfy a production expectation.

## Atomic installation model

The release harness uses real files in a newly created private temporary
directory and models a cross-platform dual-slot installer:

1. Read the highest-generation pointer whose slot record, application bytes,
   local-data copy, hashes, and health marker all validate.
2. Require free space for at least twice the new artifact plus current local
   data. A platform installer may require a larger documented value.
3. Write the verified application to a new staging slot with create-only
   operations.
4. Copy current local data and run the migration against the copy. The active
   copy is never modified in place.
5. Hash and record the staged application and migrated data, then atomically
   rename the completed staging directory to its inactive slot.
6. Write the inactive generation pointer. The old pointer remains valid
   throughout this operation.
7. Run bounded startup health checks. Only after success is the new slot marked
   healthy. Until then, startup selection ignores it and launches the prior
   healthy generation.
8. Retain both healthy generations. A retry of the same successful update ID
   and digest returns the existing generation; conflicting reuse fails.

Pointer replacement can temporarily remove only the inactive pointer. The
active pointer is never overwritten during activation. A corrupt, incomplete,
or unhealthy higher generation is ignored. Recovery first proves a healthy
slot exists, removes at most 16 bounded staging/orphan entries without
following symlinks, and reselects the healthy generation. Provider paths,
local-data contents, and operating-system errors are not returned or logged.

The harness is a reference invariant test, not a generic privileged installer.
It accepts no arbitrary command, destination path, shell input, update URL, or
post-install executable. A native implementation must reproduce these
invariants using the platform's transactional installer primitives and least
privilege.

## Failure matrix

Every required desktop runner executes the following ordered scenarios:

| Scenario                           | Required result                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Artifact corruption                | Same-length modified bytes fail the signed SHA-256 before staging.                                        |
| Download interruption              | Truncated bytes fail the declared length before staging.                                                  |
| Insufficient space                 | No staging or pointer mutation; the prior slot launches.                                                  |
| Invalid signature                  | Modified, wrongly keyed, or wrong-environment metadata fails before policy or installation.               |
| Migration failure                  | The copied migration is discarded and original local data remains authoritative.                          |
| Permission failure                 | A stable redacted error is returned and active state does not change.                                     |
| Post-activation health failure     | The unhealthy generation is ignored and recovery chooses the prior slot.                                  |
| Pre-activation interruption        | The orphan inactive slot is cleaned and the prior slot remains launchable.                                |
| Release-channel separation         | A correctly signed stable-to-nightly offer is still rejected by policy.                                   |
| Successful activation and rollback | The copied data becomes active after health success; explicit rollback restores the untouched prior copy. |

Unit coverage also checks external-key mismatch, production-versus-test key
separation, unknown signed metadata, downgrade rejection, migration exceptions,
health-check denial, successful retry deduplication, and bounded evidence.

## Running the evidence harness

From an exact clean checkout:

```sh
npm ci
npm run release:check
npm run release:update-recovery -- policy
npm run test:update-recovery
npm run release:update-recovery -- evidence \
  --expected-commit=<full-object-id> > update-recovery.json
```

The evidence record contains schema and product version, full commit, actual
host platform and architecture, public test-key ID, metadata and artifact
digests, timestamps, and one pass/fail result for every required scenario. It
contains no private key, artifact bytes, filesystem paths, local data,
credentials, hostnames, usernames, or provider errors. The ephemeral private
test key exists only in process memory and is discarded when the process ends.

The manual release-candidate workflow executes this command independently on
Linux x64, macOS arm64, macOS x64, and Windows x64 and uploads its bounded JSON
with the target evidence. Workflow artifacts in the public repository are a
90-day transfer source; release approval requires moving the result to the
restricted 180-day evidence archive and recording its digest in the candidate
document.

## Clean and existing installation recovery

For a clean installation, verify production signatures and provenance, ensure
capacity and permissions, create the first healthy slot and generation pointer,
launch offline, and confirm local-data schema before connecting an account. If
initial health fails, remove that installation; there is no prior slot to
invent.

For an existing installation, stop update retries, preserve the bounded public
failure code and update identity, disconnect network delivery, and restart. The
selector launches the newest intact healthy generation. Verify credential-store
availability, local-data schema, deep-link safety, notification privacy, and
server compatibility before reconnecting. If no healthy generation validates,
do not delete or rewrite local data. Preserve the installation, reinstall a
verified compatible artifact into a new slot, then reselect the existing data
copy only after its schema and digest pass.

Database and server rollback remain governed by the separate supported-upgrade
policy. Desktop rollback cannot reverse a PostgreSQL migration or make an old
client compatible with a new server contract. Release approval therefore needs
both desktop evidence and correlated backup, server upgrade, postflight, and
restore evidence.

## Evidence limitations

The committed tests use small non-executable payloads and ephemeral test keys.
Local success establishes the verifier and recovery state machine only. Keep
issue #117 open until retained runs use signed test installers on every target,
exercise each platform's actual permission, disk, interruption, installation,
launch, local-data, and rollback boundary, and tie the results to one exact
candidate. Production update support also remains disabled until production
signing, native signature/notarization, protected update metadata hosting, and
release-candidate approval are complete.
