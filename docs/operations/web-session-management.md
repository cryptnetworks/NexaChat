# Web session management

The web client provides registration and login forms, an account summary, profile and password controls, active-session inventory, owned-session revocation, all-other-session revocation, and current-session logout. Password fields use the appropriate password-manager autocomplete tokens and are bounded before submission. Authentication failures remain generic. Every authenticated mutation requires the exact configured Origin, `x-nexa-csrf: 1`, and the HttpOnly SameSite=Strict session cookie; production cookies also use `Secure` and the `__Host-` prefix.

`GET /v1/sessions` is account-rate-limited and lists at most 100 active,
unexpired sessions at the current credential version. PostgreSQL revalidates the
active account and credential version in the bounded query. Results use stable
newest-activity, creation-time, and public-handle ordering; the current request
touches its session first, so the current device remains visible even for a
large inventory. Responses contain a separately generated `sess_…` public
revocation handle, creation/last-activity/recent-auth/expiry timestamps, and
`current`. The handle is not the internal UUID or token and is never rendered
in the interface. Source addresses, user-agent strings, precise or inferred
locations, token hashes, credential versions, and revocation metadata are never
returned. The interface labels entries only as “Current device” and “Other
signed-in device.” `revoke-others` applies to every other active session,
including any beyond the displayed bound.

`DELETE /v1/sessions/:handle` conditionally revokes a handle owned by the authenticated account and returns 204 for both absent and cross-account handles. `POST /v1/sessions/revoke-others` atomically revokes every active session except the caller. Current-session logout uses `POST /v1/auth/logout`; all-session logout remains available at `POST /v1/auth/logout-all`. Account suspension, password rotation, explicit revocation, idle expiry, and absolute expiry fail authentication immediately. The periodic WebSocket revalidation sends a bounded unauthenticated control message and closes the connection after any such transition.

Single and all-other revocations append immutable security notifications and tamper-evident account audit actions without a session ID, public handle, address, location, or user-agent field. PostgreSQL compare predicates make ownership authoritative under races. Repeated or racing revocations are safe and non-disclosing.

The web client exposes labelled loading, empty, success, generic error, and focused confirmation states. Destructive device controls are keyboard operable, status changes use polite live regions, and no state relies on color. A bounded cross-tab signal contains only one allowlisted action name; it refreshes inventories, propagates logout, and closes local real-time activity. Server-side session and WebSocket revalidation remains authoritative when browser messaging or storage is unavailable.

Before release, verify authentication/session/authorization unit and PostgreSQL HTTP tests, WebSocket remote-revocation tests, CSRF and secure-cookie behavior, rate limits, audit privacy, browser accessibility, migrations and encrypted restore through schema 45, production builds and containers, dependency audit, SBOM, secret/static scans, sensitive logs, and the complete repository suite. Migrations are forward-only; rollback requires an application that explicitly supports schema 45 or a complete verified pre-migration restore.
