# Account profile management

Authenticated accounts retrieve and update their own profile at `GET /v1/account` and `PATCH /v1/account`. Mutations require the configured exact Origin, the `x-nexa-csrf: 1` header, the secure session cookie, and `expectedVersion` compare-and-swap semantics.

Usernames are trimmed, Unicode NFKC-normalized, and case-folded for uniqueness. Their public spelling is the normalized, case-preserving form; the private comparison value is never returned. Display names are NFKC-normalized, trimmed, and have internal whitespace collapsed. Usernames contain 3–32 letters, numbers, `_`, `.`, or `-`; display names contain 1–80 visible characters. A normalization collision returns the stable `identifier_unavailable` response without identifying the other account. A stale version returns `stale_write`.

Profiles expose only `id`, `username`, `displayName`, safe avatar metadata, timestamps, and `version`. They never expose normalized identifiers, account status, credential versions, password hashes, session tokens, or internal storage credentials. Biography and presence/status fields are intentionally absent because issue #33 does not authorize their privacy or lifecycle semantics.

Avatar metadata contains only an account-owned object-storage key, an allowlisted image media type, bounded byte length, and SHA-256 digest. Remote URLs are not accepted or fetched. Upload processing must independently validate decoded image content before creating an `avatars/<account-id>/...` object; this endpoint only attaches previously validated internal metadata.

Suspended accounts fail authentication before reads or writes. Profile writes are atomic, uniqueness is enforced by PostgreSQL, and concurrent updates from the same version allow exactly one winner. Logs and errors exclude submitted profile values and private account fields.

Before release, run the authentication unit and PostgreSQL integration suites, contract compatibility, accessibility automation, migrations from zero, secret and sensitive-log scans, and the complete repository verification suite.
