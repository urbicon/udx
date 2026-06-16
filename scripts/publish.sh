#!/usr/bin/env bash
set -euo pipefail

# Publishes the @urbicon packages to the Codeberg registry — config packages before
# the CLI, so their versions are already available when the CLI is published.
#
# Auth: CODEBERG_TOKEN from the environment or .env. The .npmrc provides the authToken
# line (bun publish does NOT read the token from bunfig.toml, unlike bun install).
# prepublishOnly in the CLI package rebuilds dist/ fresh before the upload.
#
# Usage: bash scripts/publish.sh [--dry-run]

if [ -z "${CODEBERG_TOKEN:-}" ] && [ -f .env ]; then
  set -a; . ./.env; set +a
fi
if [ -z "${CODEBERG_TOKEN:-}" ]; then
  echo "✗ CODEBERG_TOKEN not set (environment or .env)."
  exit 1
fi

DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="--dry-run"

for p in tsconfig biome-config commitlint-config cli; do
  echo "→ @urbicon/$p${DRY:+ (dry-run)}"
  ( cd "packages/$p" && bun publish $DRY )
done

echo "✓ All packages processed."
