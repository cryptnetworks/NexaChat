# Support and compatibility policy

This document is the canonical Nexa Chat support policy. The machine-readable
authority is `release/support-policy.json`; `npm run release:support -- policy`
checks it against the build, contract, upgrade, update, and release-candidate
matrices. A release note may narrow support for one release but cannot silently
broaden this policy.

## Current support status

Nexa Chat is pre-release. There is no supported production version and no
published artifact is implied by the repository version `0.1.0`. The targets
below are the validation scope for the first candidate. Support begins only
when a candidate for an exact commit receives a `go` decision under
`release/candidate-policy.json` and is intentionally published. Until then,
builds are for development and evaluation.

The project provides community maintenance objectives, not a contractual SLA.
Self-hosting does not transfer access to an operator's systems, and maintainers
cannot recover private deployments, credentials, or data.

## Environment matrix

All listed clients require JavaScript, cookies, WebSocket support, and a secure
HTTPS context in production. A listed version must also still receive security
updates from its vendor; reaching a floor does not override vendor end of life.
Candidate evidence records the exact browser and operating-system patch used.

| Surface         | Supported candidate floor | Architecture or scope |
| --------------- | ------------------------- | --------------------- |
| Chrome          | 136                       | Desktop web           |
| Edge            | 136                       | Desktop web           |
| Firefox         | 128                       | Desktop web           |
| Safari          | 18.5                      | Desktop web           |
| macOS desktop   | macOS 14.0                | arm64 and x64         |
| Windows desktop | Windows 11 24H2           | x64                   |
| Linux desktop   | Ubuntu 24.04 LTS          | x64                   |
| Server          | Ubuntu Server 24.04 LTS   | x64                   |

Mobile browsers, mobile applications, Windows on ARM, Linux architectures
other than x64, other Linux distributions, and other server operating systems
are not currently supported. They may work, but a compatibility report for
them is not a release blocker. Linux desktop support means the Ubuntu GNOME
environment with the repository-documented WebKitGTK and notification-daemon
prerequisites; it does not imply every compositor, desktop environment, or
downstream package format.

Desktop candidate formats are AppImage and deb for Linux, dmg and app.tar.gz
for macOS, and msi and nsis.zip for Windows. The build matrix can create an
artifact without proving runtime support. Release evidence must separately
cover installation, launch, credential storage, notifications, navigation,
updates, rollback, accessibility, and removal on clean machines at the floors
above and on the current vendor-supported versions selected for that release.

The server runs the pinned Node.js 24 line. Release validation uses Node
24.18.0 and npm 11.16.0 exactly; npm is a build tool, not a production runtime
dependency. Desktop builds use the Rust and Tauri versions pinned in the
repository. Unpinned toolchains and source builds with a modified lockfile are
outside the supported artifact set.

## Durable and coordination dependencies

| Dependency                   | Supported candidate range | Validated baseline | Role                                     |
| ---------------------------- | ------------------------- | ------------------ | ---------------------------------------- |
| PostgreSQL                   | `>=17.9.0 <18.0.0`        | 17.9 Alpine        | Authoritative durable state              |
| Valkey                       | `>=8.1.8 <9.0.0`          | 8.1.8 Alpine 3.23  | Optional, non-authoritative coordination |
| S3-compatible object storage | Adapter preview only      | SeaweedFS 4.40     | Authoritative when enabled               |

PostgreSQL patch releases in the declared major line are eligible, but each
release candidate is tested against and records one exact immutable image.
Major-version changes require a new policy range, backup/restore evidence, load
and failure tests, and explicit migration guidance. PostgreSQL is never
replaced by Valkey. Valkey loss must fail closed for coordination-dependent
decisions, may degrade presence and fan-out, and cannot grant access or erase
durable data.

The object-storage adapter is not connected to current product attachment
flows, so its baseline is not a claim of supported end-user attachments. Before
activation, a release must declare the required S3 operations, TLS and endpoint
policy, consistency behavior, retention and legal-hold semantics, backup
boundary, scanner integration, and an exact provider test matrix.

## Protocol and client/server compatibility

The only current transport contracts are HTTP v1 and real-time v1. Runtime
configuration is schema 1 and PostgreSQL is schema 45. The only declared
client/server pair is client `0.1.0` with server `0.1.0`, and it remains
candidate-only until the activation gate passes. Unknown protocol versions
fail closed; there is no implicit version negotiation.

Within a contract version, additions must follow the additive rules in the
[contract evolution policy](../architecture/contract-evolution.md). A breaking
change requires a parallel contract version, compatibility fixtures, client
migration and rollback instructions, and at least 180 days' documented
migration availability after the replacement is published. Authorization,
privacy-safe errors, idempotency, retry behavior, event identity, ordering, and
limits are compatibility behavior, not implementation details.

The current supported rolling scenario is a same-version replacement of at
least two `0.1.0` instances with no database or configuration schema change.
Both generations use HTTP v1, real-time v1, and Valkey fan-out. Candidate
evidence must show HTTP continuity, WebSocket reconnect, authorization
revalidation, stable event identity, private-resource non-disclosure, and queue
recovery. A version-changing rolling deployment is unsupported until the exact
source/target pair is listed and retained evidence passes. A schema-changing
deployment always enters maintenance, drains old instances and jobs, and uses
the upgrade preflight; mixed schema generations are not supported.

`tools/release/fixtures/compatibility/same-version-rolling.json` is a bounded
synthetic example tied to its named source baseline. It proves that the
decision code accepts the one declared shape and rejects drift. It is not a
two-host Valkey run, production availability result, or candidate evidence.

## Channels and support windows

| Channel | Intended use                    | Minimum window            | After successor | Planned end-of-support notice |
| ------- | ------------------------------- | ------------------------- | --------------- | ----------------------------- |
| Stable  | Production after candidate `go` | 365 days from publication | 180 days        | 90 days                       |
| Beta    | Evaluation, migration rehearsal | 90 days from publication  | 30 days         | 14 days                       |
| Nightly | Ephemeral development feedback  | 7 days from publication   | none            | none                          |

For stable, the later of the publication and successor windows controls. Fixes
land on the latest patch of a supported stable line; users may need to update
within that line before receiving a fix. Beta fixes target only the newest beta.
Nightly builds receive no backports. A channel is isolated: stable accepts only
stable sources, beta accepts stable or beta sources, and nightly accepts only
nightly sources, as enforced by the upgrade and update policies.

Every release note states its channel, publication date, supported source
versions, known incompatibilities, and calculated end-of-support date. Planned
changes appear in `CHANGELOG.md` and GitHub Releases. Security-sensitive changes
use GitHub Security Advisories and the private process in `SECURITY.md` before
public detail. Maintainers review this policy at least every 90 days.

An active exploit, compromised signing key, revoked platform certificate, or
vendor end of support may force an earlier boundary. Maintainers publish the
safe minimum information as soon as practical, explain why the normal notice
could not be met, and preserve the original and superseding release evidence.

## Upgrade, downgrade, rollback, and recovery

The machine-readable upgrade and update policies are narrower than a general
promise. Today they permit a clean install and `0.1.0` same-version recovery;
there is no earlier published production release to invent. Skipped versions,
downgrades, cross-channel moves not listed in policy, and version-changing
rolling deployments are unsupported.

PostgreSQL migrations are transactional and forward-only. An applied migration
has no down command. Rollback after a schema change means stopping writers and
restoring the correlated, verified PostgreSQL and object-storage checkpoint
before deploying the prior verified artifact. A binary rollback without data
restore is allowed only when that prior binary explicitly declares the current
database and configuration schemas compatible.

The desktop automatic updater remains disabled. The test harness models signed
metadata, dual slots, copy-on-write data migration, health-gated activation and
rollback, but does not prove a native installer or production signature. See
the [supported upgrade procedure](upgrades.md) and
[desktop recovery policy](update-rollback-recovery.md) for the exact boundaries.

## Maintenance and security response

Response objectives begin after a report is privately received and its
severity is confirmed. They are targets, not guarantees:

| Severity | Initial response target | Mitigation or fix target        |
| -------- | ----------------------- | ------------------------------- |
| Critical | 24 hours                | 7 days                          |
| High     | 72 hours                | 30 days                         |
| Medium   | 10 days                 | 90 days                         |
| Low      | 30 days                 | 365 days or planned maintenance |

Critical means active exploitation or an immediate path to widespread account,
credential, signing, or private-data compromise. High means material impact
with credible prerequisites. Lower severities cover bounded impact, hardening,
and defense in depth. Maintainers may adjust classification as evidence changes
and record that decision without publishing exploit details.

Only versions designated supported in their release notes receive security
fixes. If no safe fix can meet the target, maintainers publish a bounded
mitigation, disable an affected optional capability where possible, or withdraw
the release. Reports, reporter identities, private infrastructure, secrets, and
exploit evidence stay in restricted channels.

## Release compatibility review

Before publication, the release manager must:

1. Run `npm run release:support -- policy` from the exact candidate and review
   every changed environment, dependency, protocol, channel, and lifecycle
   field.
2. Confirm the root version, locks, toolchains, database/configuration schemas,
   candidate targets, and upgrade/update paths agree with the policy.
3. Run supported browser and OS floors plus the selected current versions;
   retain exact version, platform, architecture, artifact, and result records.
4. Exercise every supported client/server pair and direct upgrade path. Run the
   same-version two-replica rolling scenario with real PostgreSQL and Valkey,
   including reconnect, slow consumer, authorization change, backlog, and
   replica failure.
5. Record `compatibility-review` and `rolling-upgrade` evidence digests in the
   candidate record. Synthetic fixtures, skipped tests, hashes without retained
   source evidence, or a build-only platform result cannot pass these gates.
6. Calculate and publish channel-specific support and end dates, notice and
   migration guidance, advisory locations, and any unsupported combinations.

Any unreviewed matrix change, missing floor, stale-index disclosure, mixed
schema generation, unsupported dependency, or incomplete candidate evidence is
a no-go. Release publication never expands support merely because an artifact
was successfully built.
