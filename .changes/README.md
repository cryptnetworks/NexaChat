# Release-note fragments

Every user-visible, operator-visible, security, compatibility, or release-process
change must add one reviewed JSON fragment. The filename is
`<issue>-<lowercase-slug>.json`; its issue number must match the `issue` field.
Pure refactors and test-only changes may use the `internal` audience, but still
need a fragment when they affect release evidence.

Fragments are bounded, validated, sorted deterministically, and consumed only by
the explicit release preparation command. A fragment is an input to review, not
proof that review happened. Approval remains a protected-branch responsibility.

```json
{
  "schemaVersion": 1,
  "issue": 101,
  "category": "changed",
  "summary": "Add deterministic workspace version and changelog validation.",
  "audience": "operators",
  "packages": ["nexa-chat"],
  "breaking": false,
  "migration": null
}
```

Allowed categories are `security`, `added`, `changed`, `fixed`, `deprecated`,
and `removed`. Allowed audiences are `users`, `operators`, `developers`, and
`internal`. Breaking changes require concise migration instructions.
