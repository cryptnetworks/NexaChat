# Supply-chain and security verification

The repository has two verification lanes. Pull requests run the complete
format, lint, strict-type, architecture, compatibility, test, production-build,
dependency-review, license, secret, static-analysis, migration-order, Compose,
and application-SBOM gates. Default-branch pushes and the Wednesday schedule
also build every production image with BuildKit provenance, scan the image set,
and validate an image SBOM for each artifact.

## Trust boundary and fork safety

Pull-request workflows use the `pull_request` event on an ephemeral GitHub-hosted
runner. They receive only `contents: read`, never reference repository secrets,
disable checkout credential persistence, and do not request identity, package,
attestation, security-event, or contents write permission. Dependency review has
only the additional `pull-requests: read` permission. Contributor code is never
run from `pull_request_target`, `workflow_run`, or a comment-triggered privileged
workflow. Do not add one of those patterns to work around fork restrictions.

Node installation uses the lockfile and the pull-request cache scope. Untrusted
dependency lifecycle scripts are disabled during installation. Tests and builds
still execute the proposed source, so they must remain on the read-only,
secret-free pull-request lane. Scheduled and default-branch image jobs likewise
use no secrets or write token; publishing and deployment are separate reviewed
operations.

The documentation wiki publisher is the only reviewed workflow-level exception:
it receives `contents: write` on default-branch or manual runs so the
repository-scoped workflow token can update the companion wiki. It has no
pull-request trigger or repository-secret access, checks the repository and
default branch again at job start, checks out only documentation inputs, and is
bounded by concurrency and a five-minute timeout. Its owner, rationale, exact
permission map, and review deadline are recorded in `security-policy.json`.

## Policy and blocking thresholds

`security-policy.json` is the reviewable source for action revisions, scanner
image digests, accepted dependency licenses, ownership, review dates, and
thresholds. The verifier requires the dependency-review workflow's SPDX
allowlist to match that policy exactly. `npm run verify:security-policy` fails
on:

- an unpinned action, Dockerfile frontend, base image, Compose provider, or
  scanner image;
- a lock entry without an npm integrity digest, approved registry source, exact
  version, or reviewed license;
- a missing job timeout, broad workflow permission, unsafe pull-request event,
  secret reference, shell interpolation of event input, or absent concurrency
  cancellation;
- an undeclared, mismatched, ownerless, or overdue workflow permission
  exception;
- unordered migration filenames, missing static rules, expired policy review,
  or an invalid suppression.

Any secret finding blocks. Static rules with `ERROR` severity block. Dependency
and container findings at `HIGH` or `CRITICAL` block, including findings without
a fix. Lower-severity findings are triaged during the scheduled scan when they
are exploitable at a NexaChat trust boundary, affect data confidentiality or
integrity, or invalidate a documented assumption.

Do not suppress a finding merely because a fix is inconvenient. A suppression
must be added to `security-policy.json` with a narrow identifier and scope,
`@cryptnetworks` or another accountable owner, technical rationale, compensating
control, and an expiration or review date. The policy verifier rejects incomplete
or overdue entries. Remove a suppression as soon as its premise no longer holds.

## Reports, provenance, and triage

Source scans retain redacted Gitleaks SARIF, Semgrep SARIF, and a versioned
CycloneDX application SBOM for 30 days under an artifact name containing the
commit SHA. Production scans retain structured vulnerability JSON, a CycloneDX
SBOM per image, and BuildKit provenance metadata for the same period. Provenance
validation requires the expected target, revision and version build arguments,
an immutable output digest, the BuildKit build type, and SHA-256 material
digests. These are build records, not a release signature; release publication
must add its separately authorized signing and transparency-log policy.

Treat reports as potentially sensitive even though secret output is fully
redacted. The security owner classifies a new blocking result before retrying,
links the affected package/rule/image and exact report artifact, records whether
the path is reachable, and either fixes it or creates a bounded suppression.
Never paste credentials, private source values, complete environment dumps, or
unredacted scanner output into an issue.

## Local reproduction

Install the pinned Node/npm toolchain and Docker, then run:

```sh
npm ci --ignore-scripts
npm run format:check
npm run lint
npm run typecheck
npm run test:architecture
npm run test:contracts
npm run verify:security-policy
npm run verify:container-policy
npm test
npm run build
npm audit --audit-level=high
docker compose config --quiet
docker compose -f docker-compose.yml -f compose.development.yml config --quiet
bash scripts/run-secret-scan.sh /tmp/nexa-secret-reports
bash scripts/run-static-analysis.sh /tmp/nexa-static-reports
npm run test:security-tools
npm sbom --sbom-format cyclonedx > /tmp/nexa-chat.cdx.json
npm run verify:sbom -- /tmp/nexa-chat.cdx.json
```

The two scanner helpers run immutable images with no network, all capabilities
dropped, no privilege escalation, a read-only root filesystem, bounded
resources, and a read-only source mount. The controlled-fixture test synthesizes
disposable secret and unsafe-code inputs at runtime and must prove both scanners
fail closed. It never stores a credential fixture in repository history.

Use `NEXA_VERIFY_SCAN=1 bash scripts/verify-production.sh` for the complete
production container, image SBOM, vulnerability, HTTPS/WSS, isolation, and
shutdown verification described by the production deployment guide.

Container-related pull requests also run the path-filtered application-container
lane. It builds only the server and web artifacts, validates their metadata,
licenses, runtime contents, and vulnerability/SBOM reports, then exercises the
full development topology. This consolidates expensive Docker work into one
bounded job and avoids consuming hosted minutes for unrelated changes. Run
`bash scripts/verify-development-containers.sh` locally when Docker is available.

## Updating actions and scanners

Review upstream release notes, maintainer provenance, security advisories,
license, and platform support. Resolve the release tag to the upstream commit or
multi-architecture image digest; never copy a mutable tag alone. Update the
workflow reference, human-readable version comment, executable helper pin, and
`security-policy.json` in one change. Run the controlled fixtures, complete
source lane, production image scan, and provenance validation. Set a new bounded
policy review date and document any changed rule behavior or new finding.
