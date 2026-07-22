# Desktop credential persistence

NexaChat stores remembered desktop session material only in the operating
system's protected credential service. The implementation uses macOS Keychain,
Windows Credential Manager, or a Secret Service-compatible Linux desktop. It
never falls back to a preferences file, browser storage, environment variable,
command-line argument, or log record. A locked, missing, denied, or unsupported
credential service produces the stable `store_unavailable` state.

The native process is the trust boundary. Only the bundled `main` webview can
invoke the six explicitly listed credential commands. Remote origins receive no
capability. The frontend can save a newly issued token with affirmative user
consent and can list, select, or remove account metadata, but no IPC command can
read a stored token back into JavaScript. Session use must remain in trusted
native code. Command inputs and native responses are bounded and independently
validated on both sides of IPC; errors contain stable codes without provider,
account, origin, or secret details.

## Data model and lifecycle

- At most 20 account-and-instance records are stored in fixed, enumerable
  keychain slots. Each record is at most 2 KiB and contains a schema version,
  canonical HTTPS origin, canonical account ID, display label, expiration,
  idempotency operation ID, and the opaque 43-character session token.
- Production accepts HTTPS instance origins only. Debug builds additionally
  accept exact loopback HTTP origins. Credentials containing user information,
  a path, query, or fragment are rejected.
- Labels are limited to 80 characters and 320 UTF-8 bytes. Expiration must be
  in the future and no more than 366 days from the storage operation.
- Repeating an operation ID with the same payload performs no write. Reusing it
  with another payload returns `idempotency_conflict`.
- The selected slot is a separate versioned record with a SHA-256 integrity
  check. If that small record is interrupted or corrupt, NexaChat rebuilds it
  with no account selected while retaining every valid session.
- Startup and every operation scan only the 20 known slots. Expired entries are
  deleted, missing selected entries are cleared, duplicate identities or
  operation IDs and malformed secret records stop access with `store_corrupt`,
  and account lists use deterministic origin/label/ID ordering.
- Removing one account and clearing all accounts are idempotent. A partial
  provider failure returns `store_unavailable`; successful deletions remain
  deleted and a retry completes the bounded remainder. Clearing enumerates all
  slots even when metadata is corrupt.
- A single-instance guard serializes normal desktop access. In-process commands
  also share a mutex, and the second-instance callback ignores all command-line
  arguments and working-directory data rather than logging or interpreting it.

The current authenticated web flow uses HTTP-only cookies and does not expose a
session token to browser JavaScript. Wiring desktop-native login and requests to
the private token accessor must preserve that property; adding a token-reading
IPC command is prohibited.

## Platform and recovery evidence

The native adapter targets non-sandboxed macOS, Windows, and Linux desktop
builds supported by Tauri 2. macOS arm64 is the currently exercised platform:
the ignored integration test writes, reads, deletes, and verifies deletion of
an ephemeral Keychain item. Windows and Linux compile/runtime evidence belongs
in the release-candidate platform matrix before those artifacts can be called
supported. Linux environments without an unlocked Secret Service are expected
to report unavailable; sandbox packages additionally need a reviewed portal or
service policy and are not implicitly supported.

Run the deterministic and host integration checks with:

```sh
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml \
  credentials::tests::platform_keyring_round_trip -- --ignored --exact --test-threads=1
```

The host test uses a unique service name and removes its synthetic value before
asserting. It is test-signing evidence neither for an installer nor for an
update artifact. Secret buffers are zeroized on drop and debug output is
redacted, but an already-compromised native process or operating system can
still inspect process memory. OS account access, disk encryption, crash-dump
policy, and credential-store backup behavior remain part of the platform trust
model.
