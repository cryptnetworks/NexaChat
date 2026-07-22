# Desktop notifications

Desktop notification delivery is an opt-in adapter over the durable notification
records and scoped preferences already enforced by the server. The renderer is
not an authority and cannot provide notification titles, bodies, resource
identifiers, or arbitrary activation URLs to the native process.

## Trust and delivery flow

1. The user selects **Turn on desktop notifications**. Nexa Chat never requests
   operating-system permission during startup, reconnect, or background work.
2. The native command requests permission only with the explicit
   `userInitiated` flag. Denial is retained by the platform and is presented as
   a state the user can resolve in system settings; it is not repeatedly
   prompted.
3. The client establishes an account-scoped checkpoint without replaying old
   notifications. Every 30 seconds it POSTs that opaque checkpoint to
   `/v1/desktop-notification-deliveries/query`. No account or notification
   identifier is placed in the URL.
4. The server authenticates the account, rechecks current resource visibility,
   blocking and membership through `NotificationService.list`, then evaluates
   the current scoped preference and mute expiry. Read, archived, expired,
   inaccessible, and preference-suppressed records produce no delivery.
5. The server returns at most 20 envelopes in deterministic
   `(updatedAt, id)` order. An envelope contains only notification identity,
   kind, version, the literal `/notifications` route, and an opaque checkpoint;
   it contains no actor, account, community, space, message, or attachment data.
6. Native IPC independently validates the UUID, bounded version, known kind,
   and exact route. It renders only compiled constant copy. Privacy mode, which
   defaults on, also hides the notification kind. The native gate accepts at
   most 10 attempts per minute and remembers 256 successful identities to
   suppress renderer retries.
7. The account-scoped device preference and checkpoint are synchronously saved
   after each accepted or duplicate delivery. A provider or storage failure
   leaves the last successful checkpoint intact so polling can retry. Server
   overflow is explicit; the most recent bounded window wins instead of
   generating an unbounded toast storm.

The checkpoint and device preference are non-secret renderer state. Session
tokens remain in the OS credential store and never enter this flow. Modifying
renderer storage cannot add private notification content or bypass the server's
resource checks; at worst it can request bounded generic notifications. Native
and server errors use fixed codes, and the native path does not log payloads.

## Activation and privacy behavior

The desktop notification plugin does not expose notification action callbacks
on desktop platforms (its actions API is mobile-only). Nexa Chat therefore does
not embed a URL or private identifier in an operating-system toast and performs
no automatic desktop navigation when a toast is clicked. The platform may
focus the installed application. The only accepted route in the delivery
contract is `/notifications`, which is an authenticated inbox that revalidates
resource visibility when rendered. Future click routing must stay on that
allowlist and must not accept command-line, custom-scheme, or payload-provided
URLs. No route is preferable to an unsafe deep link.

Lock-screen copy is generic in privacy mode. With privacy mode disabled, the
title may disclose only one coarse type: mention, reply, invitation, or
moderation update. Message text, member names, community names, counts, and
resource identifiers are never sent to the native provider. Blocking, deletion,
membership loss, or preference changes that race after the server response
cannot disclose content because the already-issued envelope is still generic;
opening the inbox performs current authorization again.

## Support and failure matrix

The adapter pins `tauri-plugin-notification` 2.3.3. Its upstream desktop support
targets installed Windows applications, macOS, and Linux notification daemons.
Windows development builds do not provide representative application identity
or icon behavior. Headless Linux sessions and unavailable notification daemons
degrade to `unavailable` or `delivery_failed`; Nexa Chat does not fall back to a
shell command, browser payload, or custom provider.

On current desktop targets the upstream plugin queues provider work
asynchronously, so `accepted` means the plugin accepted the request, not that the
operating system proved it was displayed. A later daemon rejection is not
observable through this API. Platform smoke tests and retained release-candidate
evidence are therefore required before claiming visible-delivery success.

Current local evidence covers the macOS arm64 compile and release build, a host
provider smoke request accepted by the unsigned test application, and a
fake-provider matrix for permission denial, invalid input, duplicate and retry
behavior, provider failure, rate-limit boundaries, privacy copy, polling restart
checkpoints, muted preferences, and permission loss. The smoke result does not
prove user-visible delivery or signing identity. Windows installed-package and
Linux desktop-daemon tests remain release-candidate matrix requirements and must
not be inferred from compilation.

Run the deterministic checks with:

```sh
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run test:desktop
npx vitest run apps/web/src/desktop-notifications.test.tsx \
  apps/server/test/notifications.integration.test.ts
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml \
  notifications::tests::platform_notification_provider_smoke -- \
  --ignored --exact --test-threads=1
```
