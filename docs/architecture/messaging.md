# Messaging reliability and safety

Unread state is a durable `(account, space)` high-water mark. Message ordering uses
`(created_at, id)`, mentions use stable account identifiers, and counts saturate at 999. Reads and mark-read commands require current space authorization; membership
loss therefore discloses neither the space nor its counters. Indexed message order
and mention columns avoid full-history scans. Tombstones and edits are reflected by
querying current message state after the high-water mark.

Client commands use actor-and-space-scoped idempotency keys. Message text is bounded
to 4,000 Unicode code points. Links are rendered locally as plain anchors without
automatic previews or server-side fetching. Drafts remain local to the authenticated
account and text space and are removed only after a confirmed send.

Reaction keys are normalized Unicode grapheme clusters from the supported allowlist.
The database uniqueness constraint makes add/remove atomic per actor, message, and
key. Archived spaces reject reaction mutations.

Slow mode is enforced using server time at the transactional persistence boundary.
Distributed coordination is fail-closed for pacing and best-effort for event fan-out;
HTTP remains available if fan-out is degraded and reconnecting clients reconcile via
the durable message API. Event UUIDs survive publication and duplicate deliveries are
discarded at each instance and client.
