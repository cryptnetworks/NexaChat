# Wiki publishing

Repository documentation under `docs/` is the authoritative source for the
[NexaChat wiki](https://github.com/cryptnetworks/NexaChat/wiki). The
`Publish documentation wiki` workflow runs after relevant changes reach
`main`, or when dispatched manually from `main`.

The exporter creates one flat, uniquely prefixed wiki page for every Markdown
document, rewrites links between source documents, and generates a welcoming
`Home.md`, compact `_Sidebar.md`, and topic indexes for architecture,
operations and deployment, security and privacy, and releases and support. A
bounded manifest records only generated pages. Removed source documents delete
their previously generated page, while unrelated wiki pages are preserved.
Generated pages carry a source marker and should not be edited directly because
the next successful publication replaces them.

Safe relative links between Markdown files under `docs/` become wiki links.
Links to repository files elsewhere, such as `SECURITY.md` or
`.github/CODEOWNERS`, become canonical GitHub links. A relative Markdown
link that leaves the repository or points to a missing file fails the export.
Date-stamped audit and performance-audit records stay in the repository as
evidence and are not published to the wiki, so their links also become canonical
GitHub links. This avoids publishing host-specific benchmark output and
historical review metadata as evergreen guidance.

The workflow uses the repository-scoped `GITHUB_TOKEN` with `contents: write`
only in its publication job. It does not use a personal access token, third-party
publishing action, package installation, artifact upload, scheduled run, or
pull-request trigger. The source checkout is shallow and sparse, superseded
runs are cancelled, and an unchanged export produces no commit. These choices
keep normal runs short and avoid consuming Actions minutes for unrelated code
changes.

Local verification requires only the pinned Node.js runtime:

```sh
node --test tools/wiki/export.node-test.mjs

destination="$(mktemp -d)"
node tools/wiki/export.mjs \
  --source=docs \
  --destination="$destination" \
  --repository=cryptnetworks/NexaChat \
  --branch=main
```

Inspect the generated `Home.md`, `_Sidebar.md`, topic index pages, and
rewritten links before merging. Put new detailed documentation in the
appropriate `docs/` category; keep the README to its entry-point role and
link to the published wiki instead of copying runbooks into it.

The workflow never force-pushes. A concurrent manual wiki edit that prevents a
fast-forward push fails the run for review instead of overwriting history. If
repository policy disables write-capable workflow tokens, enable `Read and
write permissions` under Actions settings for this repository; do not replace
the token with a broadly scoped personal credential.
