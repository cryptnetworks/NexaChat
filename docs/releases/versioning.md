# Versioning and changelogs

Nexa Chat uses one repository-wide [Semantic Versioning](https://semver.org/)
version. The root manifest is authoritative. Every app and package manifest,
internal dependency pin, npm lockfile workspace entry, desktop Cargo manifest
and lock entry, Tauri configuration, and upgrade-policy target must carry that
exact version. API and event schema versions remain independent compatibility
contracts.

## Change metadata and review

Each releasable change adds one bounded `.changes/<issue>-<slug>.json` fragment.
The validator accepts only the documented schema, known workspace names, sorted
unique scopes, a 240-character single-line summary, and at most 1,000 characters
of migration guidance. Breaking changes require migration guidance. Unknown
fields, duplicate issue numbers, oversized files, and control characters fail
closed. Generated Markdown escapes fragment text.

The fragment is reviewed with the implementation. A field inside the fragment
cannot prove review, so protected-branch approval remains authoritative. Review
must confirm category, audience, affected packages, compatibility impact, and
migration guidance. Security-sensitive wording must not expose secrets,
vulnerability exploit details, private identifiers, or customer data.

`npm run release:check` is read-only and runs in CI. It validates all version
surfaces and pending fragments, returning a bounded JSON summary that omits note
text. It never reads credentials or contacts a registry.

## Preparing a version

Preparation is intentionally local and has no Git, network, tag, signing, or
publishing behavior:

```sh
# Default: deterministic dry run with paths, sizes, and content digests.
npm run release:prepare -- --version=0.2.0-rc.1 --date=2026-07-22

# After reviewing the dry run, update tracked files and consume fragments.
npm run release:prepare -- --version=0.2.0-rc.1 --date=2026-07-22 --write
npm run release:check
```

The target must be a strictly newer semantic version and the date must be an
explicit valid UTC calendar date, so output does not depend on clock or locale.
Fragments and categories are sorted deterministically. Preparation writes all
temporary files before replacement; if a process or disk failure interrupts
replacement, `release:check` detects drift. Restore the tracked files with the
normal review workflow and rerun the same command. Never hide drift by editing a
lockfile or generated changelog independently.

Version selection follows these rules:

- patch: compatible fixes and internal hardening;
- minor: backward-compatible capability additions;
- major: incompatible product, API, event, storage, or operator changes;
- prerelease identifiers: release candidates or other explicitly unstable builds;
- build metadata: diagnostic identity only and never precedence.

`CHANGELOG.md` is human-facing. Release evidence, artifacts, signatures,
checksums, SBOMs, provenance, upgrade matrices, and rollout decisions are
separate controls and cannot be inferred from a version entry.
