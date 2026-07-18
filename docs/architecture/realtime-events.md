# Real-time event envelope

Every domain event is a version 1 envelope. WebSocket delivery wraps it with
the subscribed space and a positive, process-local sequence:

```json
{
  "version": 1,
  "type": "event",
  "spaceId": "uuid",
  "sequence": 12,
  "event": {
    "version": 1,
    "id": "uuid",
    "type": "message.created",
    "occurredAt": "2026-07-17T12:00:00.000Z",
    "correlationId": "uuid",
    "payload": {}
  }
}
```

`version` changes only for incompatible envelope changes. Event types are past-tense names. Payload compatibility is additive within a version; consumers ignore unknown fields and unknown event types. Identifiers support deduplication. Timestamps are UTC ISO 8601.

Sequence numbers establish ordering within one server process and space. They
are not replay cursors. Clients discard duplicate event IDs, detect non-adjacent
sequences, and fetch HTTP history after a gap, reconnect, or server restart.
Reconnect uses exponential backoff with jitter, a 30-second base cap, and eight
attempts before presenting a recoverable error.

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

The upgrade requires the exact configured browser origin and the same protected,
revocable session cookie as HTTP. Version 1 control messages include
`subscribe`, `unsubscribe`, and `heartbeat`; acknowledgements echo request IDs.
Missing and forbidden targets both return `unavailable`. Authentication and the
shared scoped permission evaluator are rechecked during active connections, so
revocation, suspension, membership changes, and resource archival remove access.

The server bounds instance, address, account, subscription, command, payload,
and outbound-buffer usage. Invalid JSON, binary, and unsupported protocol frames
close with 1007; oversized frames close with 1009; policy and rate violations
use 1008; slow consumers use 1013. Native ping/pong heartbeats terminate stale
connections. Shutdown rejects new work, emits a draining error, closes with
1001, then terminates clients that exceed the drain deadline. Metrics contain
only aggregate counters and bounded reason labels—never session identifiers,
cookies, message bodies, or subscription resource IDs.
