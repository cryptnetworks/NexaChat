# Wiki publishing

Repository documentation under `docs/` is the authoritative source for the
[NexaChat wiki](https://github.com/cryptnetworks/NexaChat/wiki). The
`Publish documentation wiki` workflow runs after relevant changes reach
`main`, or when dispatched manually from `main`.

The exporter creates one flat, uniquely prefixed wiki page for every Markdown
document, rewrites links between source documents, and generates `Home.md` and
`_Sidebar.md`. A bounded manifest records only generated pages. Removed source
documents delete their previously generated page, while unrelated wiki pages
are preserved. Generated pages carry a source marker and should not be edited
directly because the next successful publication replaces them.

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

The workflow never force-pushes. A concurrent manual wiki edit that prevents a
fast-forward push fails the run for review instead of overwriting history. If
repository policy disables write-capable workflow tokens, enable `Read and
write permissions` under Actions settings for this repository; do not replace
the token with a broadly scoped personal credential.
