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

The scoped evaluator now protects every community, space, message, and subscription boundary currently present. Direct conversations and later service boundaries remain out of scope until their domain services exist.

## Version 1 permission catalog

The version-controlled catalog is `community.view`, `community.manage`, `community.transfer`, `membership.view`, `membership.manage`, `category.view`, `category.manage`, `space.view`, `space.manage`, `message.create`, `message.manage`, `invitation.create`, `invitation.manage`, `moderation.ban`, and `moderation.audit`.

Instance decisions can apply to every community but do not grant private-content access implicitly. Community decisions inherit into its categories, spaces, and resources. Category decisions inherit only into its spaces and resources. Space decisions inherit only into resources in that space. Resource decisions affect only the named resource. The evaluator receives the validated ancestry; a decision whose scope is absent from that ancestry cannot contribute.

Evaluation selects the most specific applicable explicit decision. At the same specificity, denial wins across all assigned roles. Owner authority is evaluated after actor/session validity and before role decisions. Preview and command enforcement call the same exported evaluator and return only the permission, outcome, safe reason, and contributing scope. HTTP authorization denial is intentionally normalized to `not_found` so callers cannot probe private resource existence.

Role and permission mutations use idempotent keys and transactions. Role versions reject stale writes; PostgreSQL uses serializable transactions for sensitive authorization changes. Ownership transfer locks and validates an active successor, changes the single `communities.owner_id` value atomically, and rejects stale concurrent transfers. The owner cannot be removed through role assignment because ownership is not represented as an ordinary role.
