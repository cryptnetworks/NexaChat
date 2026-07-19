# Real-time event envelope

Every server event is UTF-8 JSON with this version 1 envelope:

```json
{
  "version": 1,
  "id": "uuid",
  "type": "message.created",
  "occurredAt": "2026-07-17T12:00:00.000Z",
  "correlationId": "uuid",
  "payload": {}
}
```

`version` changes only for incompatible envelope changes. Event types are past-tense names. Payload compatibility is additive within a version; consumers ignore unknown fields and unknown event types. Identifiers support deduplication. Timestamps are UTC ISO 8601.

Version 1 does not promise durable delivery. HTTP history is the reconciliation
source after reconnecting; a future real-time resume cursor requires durable
sequencing and a separate ADR.

Message mutations emit `message.created`, `message.updated`, or
`message.deleted` after persistence succeeds. Clients reconcile by message ID,
replacing an existing entry instead of appending duplicates. Creation accepts a
per-author, per-space idempotency key; retries return the stored message and do
not emit a second event.

History is ordered by the server-owned `(created_at, id)` tuple. Edits preserve
`created_at`, set `updated_at`, and increment an optimistic version. Deletion is
a tombstone: body content is removed while identifiers, timestamps, and reply
references remain. Concurrent edit/delete attempts have one winner and one
stale-write response.

The Phase 0 server accepts a validated `subscribe` control message containing a
space ID and development actor ID. It uses the shared scoped permission
evaluator, returns stable errors for malformed, unknown, or forbidden requests,
and is disabled unless the development identity flow is explicitly enabled.
Authenticated production WebSocket sessions, origin checks, and per-connection
limits remain planned.
