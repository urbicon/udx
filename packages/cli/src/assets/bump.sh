#!/usr/bin/env bash
set -euo pipefail

# Versionsbump + Changelog + annotated Tag (Conventional Commits -> git-cliff).
# Verwaltet von @urbicon/udx — Änderungen via `udx sync` zurückspielen.
# Bun-nativ (kein node/npm nötig). Unified versioning: liegt ein packages/-Ordner
# vor, erhalten alle nicht-privaten Sub-Packages dieselbe Version wie das Root-Package.
#
# Usage: scripts/bump.sh <patch|minor|major>
# Env:   BUMP_SKIP_VERIFY=1  überspringt build/test vor dem Tag.

LEVEL="${1:-patch}"

if [[ "$LEVEL" != "patch" && "$LEVEL" != "minor" && "$LEVEL" != "major" ]]; then
  echo "Usage: $0 <patch|minor|major>"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree has uncommitted changes. Commit or stash first."
  exit 1
fi

if [[ "${BUMP_SKIP_VERIFY:-0}" == "1" ]]; then
  echo "⚠ Skipping build/test verification (BUMP_SKIP_VERIFY=1)"
else
  has_script() { bun -e "process.exit(require('./package.json').scripts?.['$1'] ? 0 : 1)" 2>/dev/null; }
  if has_script build; then echo "→ bun run build"; bun run build; fi
  if has_script test; then echo "→ bun test"; bun test; fi
fi

ROLLBACK_REF=$(git rev-parse HEAD)

rollback() {
  local code=$?
  echo "✗ Bump failed (exit $code) — rolling back to $ROLLBACK_REF"
  if [ -n "${VERSION:-}" ]; then
    git tag -d "v$VERSION" >/dev/null 2>&1 || true
  fi
  git reset --hard "$ROLLBACK_REF" >/dev/null 2>&1 || true
  exit "$code"
}
trap rollback ERR INT TERM

# 1. Root-Version berechnen (patch/minor/major) und schreiben — bun-nativ.
VERSION=$(bun -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const [maj, min, pat] = (pkg.version ?? "0.0.0").split(".").map(Number);
  const lvl = process.argv[1];
  const next = lvl === "major" ? [maj + 1, 0, 0]
             : lvl === "minor" ? [maj, min + 1, 0]
             : [maj, min, pat + 1];
  pkg.version = next.join(".");
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  console.log(pkg.version);
' "$LEVEL")
echo "New version: v$VERSION"

# 2. Sub-Packages (falls vorhanden) auf dieselbe Version setzen.
PKG_FILES=$(bun -e '
  const fs = require("fs");
  const path = require("path");
  const SKIP = new Set(["node_modules", "dist", "build", ".git", ".svelte-kit"]);
  if (!fs.existsSync("packages")) process.exit(0);
  function find(base) {
    const out = [];
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const p = path.join(base, e.name, "package.json");
      if (fs.existsSync(p)) out.push(p);
      const nested = path.join(base, e.name);
      for (const s of fs.readdirSync(nested, { withFileTypes: true })) {
        if (!s.isDirectory() || SKIP.has(s.name)) continue;
        const sp = path.join(nested, s.name, "package.json");
        if (fs.existsSync(sp)) out.push(sp);
      }
    }
    return out;
  }
  const pkgs = find("packages");
  for (const file of pkgs) {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (pkg.private) continue;
    pkg.version = process.argv[1];
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  }
  console.error("Updated " + pkgs.length + " package(s)");
  console.log(pkgs.join("\n"));
' "$VERSION")

# 3. Lockfile aktualisieren
bun install --silent

# 4. Changelog generieren
bunx git-cliff --tag "v$VERSION" --output CHANGELOG.md

# 5. Genau die berührten Dateien stagen (nie `git add -A`).
git add package.json CHANGELOG.md
while IFS= read -r f; do
  [ -n "$f" ] && git add "$f"
done <<<"$PKG_FILES"
git commit -m "chore: release v$VERSION" --no-verify
git tag -a "v$VERSION" -m "v$VERSION"

trap - ERR INT TERM

echo "Done: v$VERSION"
echo "Push with: git push --follow-tags"
