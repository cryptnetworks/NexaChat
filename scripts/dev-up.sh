#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
bash scripts/check-toolchain.sh

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo 'Created .env from the reviewed development template.'
fi

npm ci
docker compose up -d --wait
echo 'Dependencies are healthy; starting the API and web development servers.'
exec npm run dev
