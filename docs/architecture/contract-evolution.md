# Backward-compatible contract evolution

The shared Zod schemas in `@nexa/api-contracts` and
`@nexa/realtime-contracts` are the runtime authority for public transport
contracts. Committed examples in `contracts/v1` are published compatibility
fixtures, not disposable test data. CI runs `npm run test:contracts` and requires
every valid v1 fixture to remain accepted and every invalid boundary fixture to
remain rejected.

## Additive changes

Within version 1, changes may:

- add an optional request field with behavior identical to omission;
- add a response field when clients can safely ignore unknown fields;
- add a new endpoint or event type without changing existing semantics;
- add a stable error code for a genuinely new failure class;
- widen a documented numeric or string limit when resource safety is preserved;
- append representative fixtures while leaving existing fixtures unchanged.

Even additive changes require runtime schemas, TypeScript types, positive and
negative fixtures, transport integration tests, and documentation in the same
commit. Authorization, privacy, retryability, limits, and redaction behavior are
part of the contract, even when they are not visible in a type signature.

## Breaking changes

Removing or renaming a field, making an optional field required, narrowing an
accepted value or limit, changing a field type or meaning, changing status/code
mapping, reusing an error code, changing retry or idempotency semantics, or
altering event ordering is breaking. A breaking change must introduce an
explicit new API/envelope version, keep the old version available for a
documented migration window, add a parallel fixture directory, and include
upgrade, rollback, and client migration guidance. Existing version directories
must not be edited to make a breaking implementation appear compatible.

WebSocket commands and deliveries carry their own literal version and close-code
policy. HTTP errors carry `version`; HTTP success resources currently version at
the endpoint/contract-fixture level. A future breaking HTTP resource change uses
a new endpoint version rather than silently changing v1.

## Review and recovery

Reviewers run `npm run test:contracts`, inspect fixture diffs, and confirm that
new invalid fixtures cover boundaries and private failure behavior. Generated
output is not committed. A compatibility-test failure blocks release. Recovery
is to restore the prior schema behavior or deliberately add the parallel new
version; weakening or deleting the old fixture is not an acceptable fix.

Fixtures contain synthetic identifiers and content only. They must never include
real credentials, tokens, private content, addresses, or personal data. This
process adds no runtime dependency, migration, queue, retry, or deployment state.
