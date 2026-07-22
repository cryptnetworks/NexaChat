# Release artifact integrity and signing

Nexa Chat release bundles are fail-closed collections of platform artifacts,
two CycloneDX software bills of materials (SBOMs), an in-toto/SLSA provenance
statement, a deterministic checksum file, a canonical release manifest, and a
detached Ed25519 signature. This is an integrity envelope. It complements but
does not replace native platform code signing, notarization, malware review, or
the retained release-candidate matrix.

## Trust boundaries

The build worker may create artifact payloads and SBOMs, but it does not decide
what an operator trusts. The signing step requires explicit version, channel,
platform, architecture, key environment, and a private-key file. The key must
be a bounded regular Ed25519 PKCS#8 file outside the bundle and, on POSIX, mode
`0600` or stricter. The command never prints the key or its path. Production
automation must obtain it from a protected signing environment or hardware-
backed service, materialize it only on an isolated ephemeral worker when
necessary, and erase the temporary file on every outcome.

Verification requires a public key supplied outside the bundle. An embedded or
download-adjacent public key is not a trust root. Operators must obtain the
production key ID and key through an independently authenticated support or
installation channel. The `keyEnvironment` field prevents accidental test and
production mixing, but its text is not proof of identity; the separately
trusted key ID is authoritative. Revoked key IDs fail verification even when a
signature is mathematically valid.

The tooling does not read application credentials, session material, signing
service tokens, crash data, or user content. Its bounded JSON output contains
only version, channel, target, counts, signature state, and public key ID.
Private-key parsing failures and dependency inventory failures are redacted.

## Format and bounds

All products use the exact repository semantic version. Artifact names are:

```text
NexaChat-<version>-<channel>-<platform>-<architecture>.<format>
```

Channels are `stable`, `beta`, and `nightly`; platforms are `macos`, `windows`,
and `linux`; architectures are `x64` and `arm64`. Accepted container formats are
listed below. Acceptance by the assembler defines syntax, not a claim that a
target is supported or has passed release validation.

| Platform | Accepted formats                   |
| -------- | ---------------------------------- |
| macOS    | `dmg`, `app.tar.gz`                |
| Windows  | `msi`, `nsis.zip`                  |
| Linux    | `AppImage`, `deb`, `rpm`, `tar.gz` |

A bundle has 1–16 regular files before controls, no links or directories, at
least one artifact, exactly one npm SBOM and one Cargo SBOM, artifacts no larger
than 4 GiB each, and metadata no larger than 16 MiB each. Unexpected or hidden
files, unsafe names, unsupported formats, duplicate manifest entries, and size
or digest mismatches fail. The manifest itself is canonical sorted JSON. The
checksum file is sorted by filename. Existing generated files are accepted only
when byte-identical, making retries idempotent without silently overwriting
conflicting evidence.

## SBOM, provenance, and reproducibility

Generate both inventories from the pinned npm and Cargo locks. `npm sbom` uses
`--package-lock-only`; random npm serial identity and wall-clock time are
replaced with a lock-derived UUID and explicit `SOURCE_DATE_EPOCH`. The Cargo
inventory records every locked package, registry checksum when available, and
the Cargo lock digest. Generation fails rather than returning partial output.

```sh
mkdir -p /absolute/staging/directory
npm run release:sbom -- generate \
  --output-directory=/absolute/staging/directory \
  --source-date-epoch="$SOURCE_DATE_EPOCH"
```

The assembler records the full source object ID, repository version, exact
target, explicit build invocation ID, builder URI, source epoch, and both lock
digests. A local invocation uses `urn:nexa:builder:test` only for test evidence;
production uses the immutable HTTPS identity of its protected CI or signing
builder. Do not place secrets, actor email addresses, filesystem paths, or raw
CI environment values in either identifier.

```sh
npm run release:artifacts -- assemble \
  --directory=/absolute/staging/directory \
  --version=0.2.0-rc.1 --channel=beta --platform=macos --arch=arm64 \
  --commit=<full-object-id> --source-date-epoch="$SOURCE_DATE_EPOCH" \
  --builder-id=https://trusted.example/builders/nexa-release-v1 \
  --invocation-id=<bounded-nonsecret-run-id>
```

Reproducibility is established only by two clean isolated builds from the same
commit, dependency locks, toolchains, target, and source epoch, comparing the
payload artifact hashes before provenance is added. Matching a single local
build, reusing one workspace, or reproducing only the manifest is insufficient.
If native packagers inject nondeterministic metadata, document and review the
normalization or diff; never bless an unexplained difference.

## Signing and offline verification

Signing is a separate explicit command so build-only jobs cannot silently gain
key access:

```sh
npm run release:artifacts -- sign \
  --directory=/absolute/staging/directory \
  --private-key=/protected/ephemeral/release-key.pem \
  --key-environment=production \
  --version=0.2.0-rc.1 --channel=beta --platform=macos --arch=arm64 \
  --commit=<full-object-id>
```

Ed25519 signatures are deterministic and cover the exact canonical manifest.
The manifest covers every artifact, both SBOMs, provenance, and `SHA256SUMS`.
The signature record embeds no public key. After signing, remove the ephemeral
key even on cancellation or failure, and never upload it with logs or artifacts.

An operator downloads the bundle and separately trusted public key, supplies
the expected identity rather than accepting manifest claims, and verifies
offline:

```sh
npm run release:artifacts -- verify \
  --directory=/absolute/downloaded/directory \
  --trusted-public-key=/independently/trusted/nexa-release-public.pem \
  --key-environment=production \
  --version=0.2.0-rc.1 --channel=beta --platform=macos --arch=arm64 \
  --commit=<full-object-id>
```

Any missing or additional file, symlink, truncation, corruption, invalid
signature, unexpected target/channel, wrong key, or test/production mismatch is
a hard failure. Delete the suspect download, retain only bounded public
diagnostics (expected identity, key ID, filename, failure code), reacquire from
an authorized source, and verify again. Never execute an artifact merely to
diagnose an integrity failure.

## Native platform signatures

The detached envelope authenticates bytes but does not make an operating system
trust an application. Before a target can be supported:

- macOS bundles require Developer ID signing, hardened runtime review,
  notarization, ticket stapling, and independent `codesign`, `spctl`, and
  stapler validation on supported macOS versions;
- Windows installers and executables require Authenticode from the protected
  Windows signing identity, a trusted timestamp, and independent signature and
  chain validation on supported Windows versions;
- Linux artifacts retain the detached release signature; signed package
  repositories require their own offline-managed repository metadata key and
  client verification tests.

Native identities use separate least-privilege credentials and rotation and
revocation procedures. A valid detached signature must not hide an absent,
expired, revoked, incorrectly scoped, or invalid native signature.

## Retained issue #102 evidence

`tools/release/fixtures/test-signing` contains a synthetic non-executable
artifact, minimal SBOMs, manifest, checksums, provenance, detached signature,
and only the public half of an ephemeral Ed25519 key. The private half was
destroyed immediately after the committed bundle verified. The fixture is
checked by the release test suite and is unambiguously marked `test`.

This is valid cryptographic test-signing evidence. It is not production signing
evidence and is not evidence for Apple, Microsoft, a package repository,
notarization, a published release, or any supported platform. Production
signing remains incomplete until a protected signing run and independent
platform verification are retained against the exact candidate artifacts.
