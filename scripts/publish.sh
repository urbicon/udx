#!/usr/bin/env bash
set -euo pipefail

# Publishes the @urbicon-ui packages to the public npm registry — config packages before
# the CLI, so their versions are already available when the CLI is published.
#
# Auth: NPM_TOKEN from the environment or .env. The .npmrc provides the authToken
# line (installing needs no token; scoped packages go public via publishConfig.access).
# prepublishOnly in the CLI package rebuilds dist/ fresh before the upload.
#
# Usage: bash scripts/publish.sh [--dry-run]

if [ -z "${NPM_TOKEN:-}" ] && [ -f .env ]; then
  set -a; . ./.env; set +a
fi
if [ -z "${NPM_TOKEN:-}" ]; then
  echo "✗ NPM_TOKEN not set (environment or .env)."
  exit 1
fi

DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="--dry-run"

for p in tsconfig biome-config commitlint-config cli; do
  # Report the package name, not the directory — they differ (packages/cli → @urbicon-ui/udx).
  name=$(grep -m1 '"name"' "packages/$p/package.json" | cut -d'"' -f4)
  echo "→ ${name}${DRY:+ (dry-run)}"
  ( cd "packages/$p" && bun publish $DRY )
done

echo "✓ All packages processed."
