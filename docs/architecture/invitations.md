# Controlled community invitations

Invitation creation requires `invitation.create` on the community. Listing and
revocation require `invitation.manage`. Invitations never grant roles; acceptance
only creates or reactivates an ordinary active membership, so a creator cannot
delegate authority they do not possess.

The server generates 32 random bytes and returns the 43-character base64url
secret only in the creation response. PostgreSQL stores only its SHA-256
protection value. List, preview, audit, diagnostics, metrics, and error responses
exclude both plaintext secrets and hashes. Browser invitation links use the URL
fragment (`#invite=...`), which is removed from browser history immediately and
is not sent in HTTP referrers.

Each record binds its community, creator, optional target account, creation and
expiry times, maximum and current uses, revocation timestamp, and optimistic
version. Limits are 1–100 uses and 60 seconds–30 days. Preview is authenticated
and reveals only community name, community ID, and expiry after the secret,
target restriction, lifecycle state, and community state validate. Other cases
return the same `invitation_unavailable` response.

Acceptance runs in one storage transaction. An optimistic conditional claim
increments use count only when the invitation version, expiry, revocation, and
remaining capacity still match; membership creation or reactivation and the
audit event commit in the same transaction. Concurrent final-use requests have
one winner. An already-active target receives its existing membership without
consuming another use, including safe retries. `left` members may rejoin;
`removed` and `suspended` members cannot bypass administration with an invite.

Creation, administration, preview, and acceptance use bounded fixed-window rate
limits. Audit events record successful creation, revocation, and acceptance and
rejected administrative attempts. The audit schema intentionally contains no
secret, hash, request body, address, or diagnostic detail.
