# Desktop application shell

NexaChat's desktop application is a thin Tauri 2 shell around the same built
React application served by `apps/web`. It does not copy domain behavior into
Rust and it does not embed a privileged web administration surface. The native
process currently registers no application commands, global shortcuts,
filesystem access, shell access, or arbitrary process execution. Its only
operating-system integration is the URL-only opener described below.

The trust boundary is the Tauri webview. Production loads only the checked-in
web build through Tauri's application protocol. A content security policy
denies framing, plugins, and a base URL override; scripts are restricted to the
application itself. The sole window is resizable down to 360 by 520 logical
pixels so the responsive web layout remains usable. Tauri capability `main` is
bound only to that window and has an empty permission list.

Rust creates the configured webview so every top-level navigation passes an
exact origin check. Production permits only Tauri's bundled application
origins; debug builds additionally permit exactly `http://localhost:5173`.
User information, lookalike hosts, alternate ports, file URLs, data URLs, and
script URLs are rejected. New webviews are always denied. A new-window request
for a parsed HTTP or HTTPS URL without embedded credentials is handed to the
operating system's default browser and then denied in the webview. The opener
plugin has no frontend permission, cannot open paths, cannot select an
executable, and never receives an unsafe scheme. Failed handoffs do not log the
URL.

Production content may connect only to its own origin and Tauri's IPC endpoint;
debug content additionally reaches the exact Vite development origin. A future
remote-instance connection flow must introduce an explicit, validated endpoint
scope instead of widening this policy to every HTTPS or WebSocket destination.
File drag-and-drop and webview developer tools are disabled by configuration.

## Pinned prerequisites

- Node.js 24.18.0 and npm 11.16.0, as pinned at the repository root.
- Rust 1.97.1 with Cargo, rustfmt, and Clippy, as pinned by
  `rust-toolchain.toml`.
- Tauri CLI 2.11.4 from the npm lockfile.
- The operating-system prerequisites documented by Tauri. macOS builds require
  Apple command-line developer tools; Linux and Windows need their documented
  webview and native build dependencies.

Install JavaScript dependencies with `npm ci`. Install the pinned Rust
toolchain with rustup, then run:

```sh
npm run test:desktop
npm run desktop:build
```

`desktop:build` builds the production web application and a native executable
without producing installers. `desktop:package` additionally asks Tauri to
create platform bundles; it is a release operation and requires each target's
packaging and signing prerequisites. Development uses `npm run desktop:dev`.

## Verification scope

The first verified native build environment is Apple arm64 with the selected
Apple Command Line Tools, Rust 1.97.1, and Tauri CLI 2.11.4. This is development
evidence, not a claim that Windows, Linux, installers, signing, notarization, or
automatic updates have passed. Those require retained platform-specific
release-candidate evidence. A desktop change is incomplete if it bypasses the
web production build, broadens native capabilities without tests and review,
or introduces an unpinned native dependency. Changes to navigation, child
windows, CSP, plugins, or capabilities require corresponding policy tests.
