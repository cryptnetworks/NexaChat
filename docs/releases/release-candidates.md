# Release-candidate validation

Nexa Chat treats a release candidate as an evidence set for one immutable
commit, dependency-lock pair, version, channel, and build epoch. A green test
job is not by itself a release decision. `release/candidate-policy.json` is the
versioned gate, and `npm run release:candidate -- validate` independently
computes `go` or `no-go` from a strict, bounded evidence document.

The current matrix is Linux x64, macOS arm64, macOS x64, and Windows x64. The
manual workflow uses GitHub's documented hosted-runner labels
`ubuntu-24.04`, `macos-15`, `macos-15-intel`, and `windows-2025`. Review the
[hosted-runner image policy](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
before changing a label. Moving aliases such as `ubuntu-latest` are prohibited
for candidate evidence.

## Decision boundary

Only a designated release manager may declare `go`. The validator does not
hold deployment, publishing, repository, signing, backup, or production
credentials and exposes no HTTP or desktop command. Running it cannot publish
or install an artifact. A `go` record requires all of the following:

- every ordered global check passed and names a retained evidence SHA-256;
- every required target is present and every ordered target check passed;
- the repository version, upgrade policy, candidate policy, exact full commit,
  npm lock, and Cargo lock agree;
- each artifact has the exact bounded platform name and was built from that
  candidate commit;
- both npm and Cargo CycloneDX inventories, a build attestation, and a
  production detached signature are recorded;
- macOS and Windows native signature verification passed, while Linux records
  native signing as not required rather than pretending it occurred;
- no risk is open, no accepted risk exceeds medium severity, accepted risks
  have accountable owners and non-overdue review dates, and a named actor
  records the final decision.

Missing, failed, or unrun checks; a partial matrix; source or lock drift; test
keys; missing attestations; contradictory decisions; and unresolved risks all
produce `no-go`. Validation exit status is `0` for go, `2` for a valid no-go,
and `1` for malformed or unsafe evidence. Output is a bounded summary with
stable failure codes. It deliberately omits risk descriptions, signing
identities, paths, provider errors, and test output.

## Required global evidence

| Gate                    | Minimum retained evidence                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Accessibility           | Keyboard, focus, screen-reader semantics, zoom, contrast, reduced-motion, high-contrast, and supported browser results              |
| Authorization           | HTTP and WebSocket privilege, private-resource non-disclosure, protected role, blocking, and reconnect results                      |
| Backup and restore      | Correlated PostgreSQL and private object-storage backup identifiers plus an isolated restoration and integrity result               |
| Clean install           | Empty durable services, migrations, readiness, dependency outage, recovery, and smoke results                                       |
| Dependency audit        | Locked dependency inventories and a passing high-severity policy result                                                             |
| Failure recovery        | Storage, network, job, retry, duplicate, timeout, partial-write, and restart injection results                                      |
| Format, lint, and types | Exact commands and successful exit records for the candidate commit                                                                 |
| Localization            | Catalog completeness, plural/date/time formats, fallback, missing keys, and RTL browser results                                     |
| Performance             | Environment, workload, warmup, samples, percentiles, variance, budgets, and regression outcome                                      |
| PostgreSQL              | Full migration and integration suite against the declared PostgreSQL image                                                          |
| Production build        | All web, server, package, and desktop build results with toolchain identities                                                       |
| Provenance              | Verified subject digests, builder identity, source commit, locks, invocation, and build epoch                                       |
| Real-time capacity      | Connections, subscriptions, event rate, fan-out, queues, memory, CPU, reconnect storm, slow consumer, Valkey, and recovery results  |
| Rollback and upgrade    | Clean install, every supported direct upgrade, interruption boundary, backup restoration, postflight, rollback, and recovery timing |
| Secret scan             | Scanner/version/policy result with findings redacted and handled outside public artifacts                                           |
| Unit and integration    | Complete suite result, including privacy, authorization, concurrency, accessibility, multi-device, and failure cases                |

A command passing in a workflow is not enough to mark a check passed. The
operator must archive its bounded result, calculate the archive object's
SHA-256, and put that digest in the evidence record. Failed checks also require
a retained digest; `not-run` must have `null` evidence so absence cannot be
presented as proof.

## Required target evidence

Every platform and architecture records the operating-system version, immutable
runner image version, Node, npm, Rust, and Tauri versions. Each target must cover
clean install, OS credential storage, desktop navigation/IPC security, native
notification permission and privacy behavior, packaging, reconnect, two clean
reproducible builds, launch smoke testing, and update recovery.

The payload is assembled with the artifact-integrity procedure, then signed in
a separate protected environment. macOS evidence includes hardened-runtime,
Developer ID, notarization, stapling, Gatekeeper, clean-install, and launch
checks. Windows evidence includes Authenticode identity, trusted timestamp and
chain, SmartScreen-compatible packaging checks, clean install, and launch.
Linux evidence includes independent detached-signature verification and native
package installation checks. Test keys are useful only for cryptographic test
coverage and always fail the production candidate gate.

GitHub artifact attestations can bind a subject digest to workflow identity,
but they supplement rather than replace the detached and native signatures.
When a protected build uses attestations, pin the action by full commit and
follow the
[artifact-attestation verification guidance](https://docs.github.com/en/actions/how-tos/secure-your-supply-chain/use-artifact-attestations/use-artifact-attestations).

## Running and retaining a candidate

1. Prepare and review a semantic version and changelog. Do not reuse a
   candidate identifier; retries increment its positive attempt number.
2. Select the exact commit when dispatching `Release candidate evidence` and
   enter the same full object ID. The pre-check rejects branches, abbreviated
   IDs, or a dispatch SHA mismatch before repository checkout.
3. Transfer the source evidence, all four target records, unsigned packages,
   and workflow logs into the approved access-controlled evidence archive. The
   public GitHub repository limits ordinary workflow artifact retention, so its
   90-day artifact is only a transfer source, not the required 180-day archive.
4. Run two isolated builds per target. Compare payload digests, investigate all
   unexplained differences, then assemble SBOM, checksum, provenance, and
   manifest records.
5. Sign only the reviewed bytes in the protected environment. Independently
   verify the production public key, native identity, attestation, checksums,
   manifest, SBOMs, source commit, locks, target, and channel.
6. Perform clean-install, upgrade, backup restoration, rollback/recovery,
   browser/accessibility, and platform smoke rehearsals. Evidence uses synthetic
   accounts and contains no messages, tokens, addresses, credentials, report
   evidence, filenames, or private infrastructure details.
7. Assemble the strict JSON record and validate it from a clean checkout:

   ```sh
   npm ci
   npm run release:check
   npm run release:candidate -- policy
   npm run release:candidate -- validate \
     --evidence=/protected/candidate-0.2.0-beta.1.json \
     --expected-commit=<full-object-id>
   ```

8. Store the candidate JSON, validator output, and their SHA-256 values for at
   least 180 days. Access is least privilege, downloads are audited, records are
   immutable, and the encryption key lifecycle follows the backup policy. A
   rerun creates a new attempt; it never overwrites or edits earlier evidence.

If a subscriber, runner, registry, scanner, signing service, timestamp service,
notary, or evidence archive is unavailable, retain the bounded failure record
and decide no-go. Never waive a gate by deleting it or marking it passed.

## Residual risks and privacy

Risk records are bounded to 32 entries and contain an opaque ID, severity,
status, accountable team identifier, review date, short summary, and
mitigation. Do not put customer data, employee email addresses, vulnerability
proofs, secrets, private addresses, raw logs, or internal topology in the
candidate document. Link such material through an access-controlled evidence
system and store only its content digest in release evidence.

Resolved risks remain useful history. An accepted low or medium risk requires
an owner and future review date. Open, overdue, high, or critical risk cannot
produce go. Revoking a signature, discovering artifact corruption, or finding
a material regression after go immediately supersedes the decision with a new
no-go record and invokes the rollback and support procedures; the original
record remains immutable.

## Retained local evidence

`tools/release/fixtures/candidate/no-go-local.json` is an intentionally
incomplete record tied to the exact `8df6623` source baseline and its two lock
digests. It references the issue #102 synthetic macOS artifact with a test-only
detached signature. The validator reports absent global checks, three missing
targets, absent native signing and attestation, source mismatch, and open
risks. This proves fail-closed decision behavior only.

It is not release-candidate approval, a performance or accessibility run, a
live PostgreSQL restore, an upgrade/rollback rehearsal, production signing,
notarization, Authenticode, an attestation, or platform support evidence. Keep
the corresponding issue open until one exact candidate has a complete retained
matrix and the independent validator returns go.
