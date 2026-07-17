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

Version 1 does not promise durable delivery. Clients reconnect with exponential backoff and reconcile through HTTP. A future resume cursor requires durable sequencing and a separate ADR. Authorization is checked when subscribing and again when producing protected data; losing access closes or filters the subscription. Production connections require an authenticated, origin-checked session and per-connection limits.
