# Reviewed dependency updates

Dependabot checks npm packages every Monday at 09:00 America/New_York and
GitHub Actions at 09:30. Minor and patch updates are grouped by npm production
or development scope and into one Actions group. Security updates form a
separate npm group so they are not delayed behind routine changes. Major
versions remain individual pull requests and observe a longer cooldown because
they require an explicit compatibility and migration review.

The repository owner `cryptnetworks` is assigned to every update. Open update
counts are bounded (five npm and three Actions), automatic rebasing is disabled
to avoid unreviewed churn, and cooldowns reduce adoption of immediately released
versions. Dependabot cannot merge, deploy, or release changes.

## Review policy

Every update must pass the required verification workflow: reproducible
`npm ci`, formatting, lint, strict types, architecture and contract gates, the
full unit/integration suite, production builds, high-severity dependency audit,
Compose configuration validation, and SBOM generation. Review the upstream
release notes and provenance. Confirm lockfile changes match the requested
packages and contain no new install scripts or unexpected registries.

For major versions, also document breaking changes, runtime and browser support,
configuration or data migration, rollback, and a representative manual test.
Never weaken a security control or compatibility fixture merely to make an
update pass. Security updates take priority; if a fix is unavailable, record the
affected surface, compensating control, owner, and next review date without
publishing exploit details.

## Failure, escalation, and recovery

Registry or audit outages fail closed: leave the update open and rerun after the
provider recovers; do not bypass `npm ci` or the audit. A weekly workflow marks
Dependabot pull requests older than 14 days `status:blocked`, assigns the owner,
and posts one escalation comment. The existing label prevents duplicate noise.
The owner then fixes the failure, records a bounded deferral, closes a superseded
update, or opens a narrowly scoped follow-up issue.

Recovery is to revert the dependency commit and lockfile together, rebuild from
the prior lockfile, and rerun the complete workflow. Dependency updates do not
authorize automatic merge, deployment, database migration, or secret changes.
Workflow failures and package names/versions are operational metadata; logs and
comments must not contain registry credentials, tokens, private content, or
unnecessary personal data. There is no user-facing or accessibility behavior.
