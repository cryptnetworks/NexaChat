# Test-signing evidence only

This fixture is a valid Ed25519 signature exercise for issue #102. The `.dmg`
is short synthetic text, not an application or installer. The signing key was
generated ephemerally on 2026-07-22; its private half was destroyed and was
never committed. `trusted-test-public.pem` is not a Nexa Chat production trust
root. The signature record says `keyEnvironment: test`, and production
verification rejects it.

The retained bundle demonstrates deterministic manifest/checksum/provenance
generation, detached signing, independent verification, corruption detection,
and test/production separation. It proves none of Apple code signing,
notarization, Windows Authenticode, package-repository signing, production key
custody, or a releasable binary.

Verify from the repository root:

```sh
npm run release:artifacts -- verify \
  --directory=tools/release/fixtures/test-signing/bundle \
  --trusted-public-key=tools/release/fixtures/test-signing/trusted-test-public.pem \
  --key-environment=test --version=0.1.0 --channel=beta \
  --platform=macos --arch=arm64 \
  --commit=80b16a2a1e043f650ebb643476af0954d34f3558
```
