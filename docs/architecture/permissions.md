# Permission model

Authorization is enforced at service boundaries. Interface visibility is never an authorization control.

## Scopes and evaluation

Scopes are ordered from instance, community, category, space, to resource. A role grants named permissions at a scope. Membership links members to community roles. Instance operators do not implicitly read private message content.

For an action, evaluation uses this order:

1. Reject suspended, removed, or blocked actors and invalid sessions.
2. The community owner may perform community actions except controls reserved to the instance or constrained by ownership-transfer rules.
3. Collect applicable roles and inherited grants from broadest to narrowest scope.
4. Apply explicit denies before grants at the same or narrower scope. A narrower explicit decision overrides inherited decisions; a deny wins ties.
5. Require every permission needed by the operation and apply resource invariants.

Absence of a grant is denial. Category decisions inherit into spaces unless explicitly overridden. Resource decisions apply only to the resource. Direct conversations use participant policy, not community roles.

## Safety invariants

- A member cannot grant a permission they do not possess at the target scope.
- Role management cannot modify an equal or higher protected role.
- The sole owner cannot leave, be removed, or lose ownership without an atomic accepted transfer.
- Bans, audit-log access, exports, integration installation, and ownership changes require recent authentication and an audit event.
- Permission changes are transactional, idempotent, and evaluated against current state at commit time.
- Preview uses the same evaluator as enforcement and explains contributing decisions without exposing protected membership data.

The first slice implements only the owner rule for space creation; broader authorization must not ship until this specification has executable decision-table tests.
