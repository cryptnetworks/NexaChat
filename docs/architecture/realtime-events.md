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

Version 1 does not promise durable delivery. A future resume cursor requires durable sequencing and a separate ADR.

The Phase 0 server accepts a validated `subscribe` control message containing a space ID and development actor ID. It allows only the owner of the space's community, returns stable errors for malformed, unknown, or forbidden requests, and is disabled unless the development identity flow is explicitly enabled. Revalidation after subscription, reconnect/reconciliation behavior, authenticated production sessions, origin checks, and per-connection limits are planned rather than implemented.
