#!/usr/bin/env bash
set -euo pipefail

# Versionsbump + Changelog + annotated Tag (Conventional Commits -> git-cliff).
# Verwaltet von @urbicon/udx — Änderungen via `udx sync` zurückspielen.
# Bun-nativ (kein node/npm nötig). Unified versioning: liegt ein packages/-Ordner
# vor, erhalten alle nicht-privaten Sub-Packages dieselbe Version wie das Root-Package.
#
# Interne Geschwister-Deps (auf Workspace-eigene Pakete) werden dabei behandelt:
#   • `workspace:*` / `workspace:^` u. Ä. bleiben unangetastet — Bun löst das
#     Protokoll beim Publish zur konkreten Version auf.
#   • ein expliziter Semver-Range wird auf eine major-kompatible Range normalisiert
#     (`^<major>.0.0`, 0.x-sicher). So bleibt etwa eine peerDependency über
#     Patch/Minor/Major hinweg erfüllbar, selbst wenn ein Sibling nicht bei jedem
#     Release neu publiziert wird und die Registry hinterherhängt. Reine
#     `workspace:*`-Setups merken davon nichts (no-op).
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

# 2. Sub-Packages (falls vorhanden) auf dieselbe Version setzen und interne
#    Geschwister-Deps mit explizitem Semver-Range major-kompatibel normalisieren
#    (siehe Kopf). `workspace:`-Deps bleiben unangetastet.
PKG_FILES=$(bun -e '
  const fs = require("fs");
  const path = require("path");
  const SKIP = new Set(["node_modules", "dist", "build", ".git", ".svelte-kit"]);
  const VERSION = process.argv[1];
  const DEP_FIELDS = ["dependencies", "peerDependencies", "devDependencies"];

  // major-kompatible Range, 0.x-sicher: bei 0.x markiert Minor (bzw. Patch) die
  // Kompatibilitätsgrenze, nicht der Major — `^0.0.0` wäre sonst nutzlos eng.
  const [maj, min, pat] = VERSION.split(".").map(Number);
  const range = maj > 0 ? "^" + maj + ".0.0"
              : min > 0 ? "^0." + min + ".0"
              :           "^0.0." + pat;

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
  const files = find("packages");

  // Namen der Pakete, deren Version dieser Bump auf VERSION hebt: das Root-Paket
  // (immer) plus alle nicht-privaten Sub-Packages — generisch über die
  // name-Felder, nie über einen hartkodierten Scope. Nur interne Ranges, die
  // auf eines davon zeigen, werden normalisiert: eine Range auf ein nicht
  // gebumptes (privates) Sibling bliebe sonst lokal unauflösbar.
  const bumped = new Set();
  const rootName = JSON.parse(fs.readFileSync("package.json", "utf8")).name;
  if (rootName) bumped.add(rootName);
  const manifests = files.map((f) => [f, JSON.parse(fs.readFileSync(f, "utf8"))]);
  for (const [, pkg] of manifests) {
    if (!pkg.private && pkg.name) bumped.add(pkg.name);
  }

  // Versionsbump nur für nicht-private Pakete; Range-Normalisierung dagegen
  // auch in privaten, damit deren lokale Links zu gebumpten Siblings passen.
  let ranges = 0;
  const written = [];
  for (const [file, pkg] of manifests) {
    let changed = false;
    if (!pkg.private && pkg.version !== VERSION) {
      pkg.version = VERSION;
      changed = true;
    }
    for (const field of DEP_FIELDS) {
      const deps = pkg[field];
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        if (!bumped.has(name)) continue;
        if (String(deps[name]).startsWith("workspace:")) continue;
        if (deps[name] !== range) { ranges++; changed = true; }
        deps[name] = range;
      }
    }
    if (changed) {
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
      written.push(file);
    }
  }
  console.error("Updated " + written.length + " package(s)" +
    (ranges ? " (" + ranges + " internal range(s) -> " + range + ")" : ""));
  console.log(written.join("\n"));
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
# Lockfile nur stagen, wenn `bun install` es als Folge des Bumps verändert hat
# (etwa weil interne Ranges in Schritt 2 angepasst wurden). Der Clean-Tree-Check
# oben stellt sicher, dass jede Änderung hier vom Bump stammt. Untrackte oder
# ignorierte Lockfiles meldet `git diff` nicht — sie bleiben außen vor.
for lock in bun.lock bun.lockb; do
  if [ -f "$lock" ] && ! git diff --quiet -- "$lock"; then
    git add "$lock"
    echo "Staged $lock (changed by bump)"
  fi
done
git commit -m "chore: release v$VERSION" --no-verify
git tag -a "v$VERSION" -m "v$VERSION"

trap - ERR INT TERM

echo "Done: v$VERSION"
echo "Push with: git push --follow-tags"
