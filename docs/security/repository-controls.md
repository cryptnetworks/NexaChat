# Repository controls and security ownership

This document records the controls that protect NexaChat's GitHub repository.
It complements the versioned supply-chain policy; it does not replace the
required workflow checks or the security review of a proposed change.

## Control owner and review ownership

The repository security owner is `@cryptnetworks`. That owner reviews the
quarterly control check, records any change to GitHub settings, and coordinates
incident response under [SECURITY.md](../../SECURITY.md).

[`.github/CODEOWNERS`](../../.github/CODEOWNERS) makes ownership explicit for
authentication, authorization, contracts, migrations, storage, workflows,
security policy, production deployment, and release paths. Code ownership is
an additional routing signal; it never substitutes for the independently
required pull-request approval.

## Default-branch policy

`main` accepts changes only through a pull request with one independent
approval, resolved review conversations, and current successful required
checks. The required checks are `verify`, `dependency-review`, and
`source-security`. Stale approvals are dismissed when a pull request changes.

Force-pushes and deletion of `main` are disabled. Administrators are subject to
the same rules; there is no standing administrator exemption. An emergency
change therefore requires a separately recorded, time-bounded ruleset change,
the incident reference, and a follow-up pull request that restores the normal
rules and records the review. Emergency use is exceptional and does not waive
the security, recovery, or release evidence required by the affected change.

## Secrets, vulnerability reports, and workflow safety

GitHub secret scanning and push protection are enabled. When the repository
plan exposes secret validity checks or non-provider patterns, the security
owner enables and tests them at the next control review. If a plan does not
expose a control, the limitation is recorded with GitHub's settings evidence;
it is never compensated for by weakening source scanning or by committing a
test credential.

Private vulnerability reporting is enabled. Reporters should use the repository
security advisory flow or the private contact route in [SECURITY.md](../../SECURITY.md),
not a public issue. The security owner triages the report, limits distribution
of the details, coordinates remediation, and records a public advisory only
after a safe disclosure decision.

Pull-request workflows use the `pull_request` event and read-only tokens. They
do not receive repository secrets, and they do not use `pull_request_target`,
comment-triggered privileged jobs, or fork-specific permission expansion. See
the [supply-chain security guide](../operations/supply-chain-security.md) for
the enforced workflow policy and local reproduction steps.

## Recurring review and evidence

Review the repository settings at least quarterly and after a material GitHub
plan, workflow, ownership, or release-process change. Retain non-sensitive
evidence of the effective ruleset, required check names, bypass actors, secret
controls available to the plan, private-reporting status, and Actions default
permissions. Do not copy secret alerts, credential values, or private reports
into this repository or a public issue.

The review verifies that:

- the default branch still requires current reviewed pull requests and the
  three named checks;
- force-push and deletion remain disabled;
- sensitive-path ownership matches the current repository layout;
- fork pull requests receive no secrets and only read-only permissions;
- secret scanning, push protection, private vulnerability reporting, CodeQL,
  and Dependabot controls remain enabled where available; and
- any emergency ruleset change was restored, reviewed, and linked to its
  incident record.
