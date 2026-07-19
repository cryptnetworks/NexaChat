#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected_node="$(tr -d '[:space:]' < "$root/.node-version")"
expected_npm="$(node -p "require('$root/package.json').packageManager.split('@')[1]")"
actual_node="$(node --version | sed 's/^v//')"
actual_npm="$(npm --version)"

if [[ "$actual_node" != "$expected_node" ]]; then
  echo "toolchain_error: Node $expected_node is required; found $actual_node" >&2
  exit 1
fi
if [[ "$actual_npm" != "$expected_npm" ]]; then
  echo "toolchain_error: npm $expected_npm is required; found $actual_npm" >&2
  exit 1
fi
docker compose version >/dev/null
