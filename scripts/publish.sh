#!/usr/bin/env bash
set -euo pipefail

# Publiziert die @urbicon-Pakete zur Codeberg-Registry — Config-Pakete vor der CLI,
# damit deren Versionen beim CLI-Publish bereits verfügbar sind.
#
# Auth: CODEBERG_TOKEN aus der Umgebung oder .env. Die .npmrc liefert die authToken-
# Zeile (bun publish liest den Token NICHT aus bunfig.toml, anders als bun install).
# prepublishOnly im CLI-Paket baut dist/ vor dem Upload frisch.
#
# Usage: bash scripts/publish.sh [--dry-run]

if [ -z "${CODEBERG_TOKEN:-}" ] && [ -f .env ]; then
  set -a; . ./.env; set +a
fi
if [ -z "${CODEBERG_TOKEN:-}" ]; then
  echo "✗ CODEBERG_TOKEN nicht gesetzt (Umgebung oder .env)."
  exit 1
fi

DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="--dry-run"

for p in tsconfig biome-config commitlint-config cli; do
  echo "→ @urbicon/$p${DRY:+ (dry-run)}"
  ( cd "packages/$p" && bun publish $DRY )
done

echo "✓ Alle Pakete verarbeitet."
