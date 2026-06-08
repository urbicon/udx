# Plan: Version-Governance & Consumer-Sichtbarkeit

> Ziel: **eine** Quelle für den vorgeschriebenen Stack (ein Bump propagiert, keine Guards
> nötig) und ein Consumer-Erlebnis, bei dem man den Zustand *sieht*, versteht *was sich
> wie ändert* und mit geläufigen Verben *selektiv* einrichtet/synchronisiert/updatet —
> bei minimaler Einarbeitung.

## Leitprinzip
Der Dev arbeitet mit Vokabular, das er aus Paketmanagern kennt (`init/status/sync/add/remove`),
sieht den Zustand statt ihn zu erfragen, und löst riskante Aktionen nur bewusst aus.

## Verifizierte Grundlagen (empirisch, Bun 1.3.14)
- `bun build` inlined die Root-`package.json` über `../../../../` → `versions.ts` als Catalog-Reader läuft standalone. ✅
- `bun outdated -r` zeigt Catalog-Drift (Spalte `catalog`). ✅ — aber **kein `--json`** (Flag wird ignoriert). ⚠️
- Unreferenzierte Catalog-Einträge sind erlaubt, aber von `bun outdated` ignoriert (→ Svelte braucht Referenzierer). ✅
- Bun bumpt Catalog-Einträge **nicht** automatisch (`bun update` un-catalog'd sogar). ❌ → eigenes Update/Renovate.
- `bun pm pack` löst `catalog:` auf (wie `workspace:`) → publish-sicher. ✅

## Getroffene Entscheidungen (Kurzfassung, Details s. Konversation)
- **D1** Source of Truth = **Bun-Catalog** (bekanntes Mechanismus, in `bun outdated` sichtbar).
- **D2** Stack-Bump = **Renovate** (Default) + Dev-Script `stack:update` (Registry-`fetch`, da kein `--json`); **kein** CLI-Subcommand.
- **D3** Svelte-Lücke = privates **`packages/svelte-fixture`** (`catalog:svelte`, dogfood + Smoke-Test).
- **D4** Sichtbarkeit = **eine Engine**, `udx status` (Mensch, Default für bare `udx`) + `--ci`/`--json`; `doctor` als Alias. Gruppierung nach Baustein, pro Zeile `[hast du]→[Soll]·Klassifikation·Befehl`.
- **D5** Sync = **sichere Änderungen automatisch** (fehlende ergänzen, *zu alte* Versionen anheben — nie Downgrade/über Voraus-Wert), `--force`/`-i` nur für lokal geänderte Dateien + Script-Drift; **`udx pin/unpin`** für bewusstes Festhalten.
- **D6** Selektiv = **`udx add/remove <baustein>`** (Hauptweg) + `sync -i` + `--only` (Power-User).
- **D7** Naming = Dev-facing `init·status·sync·add·remove` (+`--only`,`pin`); `adopt/skip/doctor` als versteckte Aliase; Fachbegriffe raus aus der Ausgabe.
- **D8** `udx sync --install` opt-in (Footer bietet es an).
- **D9** Consumer-Writes literal (Default); `catalog:` für Catalog-Consumer als **v2**.
- **D10** Scope: udx governt **Tooling-Stack (Root + per-Paket-tsconfig)**, nicht App-Runtime-Deps.

---

## Arbeitspakete (jeweils: implementieren → Tests/check/lint → commit → Review-Agent → Befunde beheben)

### WP1 — Downgrade-Fix + Pin-Angleichung  ✅ committet + reviewed
- [x] `satisfiesPin()` in `pkg.ts`: Pin = Baseline, nie Downgrade (semver-bewusst via `Bun.semver`).
- [x] Drift-Bedingung auf `!satisfiesPin` umgestellt.
- [x] Pins angeglichen (`@types/node ^25.9.2`, `@commitlint/cli ^21.0.2`, `lefthook ^1.13.6`).
- [x] Tests: `satisfiesPin`, Drift-Regression, Pin-Lag-Guard.
- [x] committen + Review → Befunde behoben (`floorVersion` überspringt Obergrenzen; Protokoll-Specifier wie `npm:`/git generisch als erfüllt).

### WP2 — Phase 0: Catalog als Single Source of Truth (verhaltensgleich)  ✅ committet + reviewed
- [x] Root-`package.json`: `workspaces.catalog` (+ `catalogs.svelte`) mit **exakt** den aktuellen Pin-Werten; **alle** udx-Pakete (root, cli, commitlint-config) referenzieren via `"catalog:"`.
- [x] `versions.ts`: Konstanten → Catalog-Reader; `DepName`/Namensgruppen exportiert, `pkg.ts` nutzt sie (keine Duplikation). Generisches `pick<N>` hält die präzisen Key-Typen.
- [x] Pin-Lag-Guard-Test → **Mirror- + Completeness-Test** + Dogfooding-Test (alle Pakete referenzieren den Catalog).
- [x] DoD: `VERSIONS` byte-identisch (Laufzeit verifiziert), Suite grün, `udx sync --dry-run` identischer Plan, dist trägt korrektes `^25.9.2`.
- [x] committen + Review → Befund (Dogfooding untested) behoben. **npm-Sicherheits-Guard verworfen**: npm spielt keine Rolle, `bun publish` löst `catalog:` auf → `catalog:` bleibt auch in publizierten Runtime-Deps (konsistent). Siehe Memory `bun-only-no-npm`.

### WP3 — Phase 1: `svelte-fixture`  ✅ committet + reviewed
- [x] `packages/svelte-fixture/package.json` (private, `catalog:svelte`) + Mini-`.svelte` + `check`-Script (prettier mit exakt vorgeschriebener `.prettierrc`/`.prettierignore` + `svelte-check`, läuft im Gate).
- [x] Sicherstellen: udx-Dogfooding zwingt der Fixture keine ungewollten Bausteine auf (Reviewer bestätigt: tsconfig create-only → skip, publish.sh listet sie nicht).
- [x] udx-Root-`biome.json` ignoriert `.svelte` (nur lokal; publizierte `biome-base` unberührt).
- [x] committen + Review → Befund (prettier-Scope) behoben (`.prettierignore`). _Caveat:_ `bun outdated` zeigt named-Catalogs (`catalogs.svelte`) evtl. nicht — in WP7 verifizieren.

### WP4 — D4: `udx status` (Sichtbarkeit) + Klassifikations-Engine  ✅ committet + reviewed
- [x] Klassifikation (in sync✓ / behind↑ / customized✎ / missing+ / pinned⊙ / declined⊘) aus `computePkgPlan` + `applyFiles`-Dry abgeleitet.
- [x] `commands/status.ts`: nach Baustein/Dateien/package.json/Registry gruppierte Tabelle, pro Zeile Befehl; Legende + Summary; `--json`.
- [x] `bin/udx.ts`: `status`-Command + bare `udx` → status; `doctor` bleibt die CI-Variante (Exit-Codes), teilt die Engines.
- [x] Tests für Klassifikation (`buildReport`) + runStatus-Smoke.
- [x] committen + Review → Befunde (String-Match, try/catch, redundanter Read, in-sync-Zählung) behoben.

### WP5 — D5: sichere Sync-Semantik + `pin/unpin`  ✅ committet + reviewed
- [x] `mutatePkg`: `devDepsDrift`(=behind) im **Nicht-Force**-Pfad anwenden (nie Downgrade); `scriptsDrift` bleibt Force-only.
- [x] Manifest: `pinned: Record<dep, range>`; `computePkgPlan` respektiert Pins (kein Drift/Add), meldet sie aber (auch fehlende → nie still).
- [x] `commands/pin.ts` (+ `bin`): `udx pin <dep> [range]` / `udx unpin <dep>`.
- [x] `harness`/`doctor` zeigen gehaltene Deps; Drift = „sync zieht hoch" (kein Force-Nag).
- [x] Tests: Auto-Pull-up ohne Force, Pin hält, unpin löst, pinned-absent gemeldet.
- [x] committen + Review → Befunde (gepinnt-fehlend still; unnötiger Roundtrip) behoben.

### WP6 — D6/D7: `add`/`remove` + Naming-Aliase  ✅ committet
- [x] `add` (= adopt + gezielter `sync --only`, überstimmt Auto-Abwahl, Dry-Run-treu via durchgereichtem `manifestOverride`) / `remove` (= decline, Dateien bleiben) als Dev-facing Verben; `status` Primärname.
- [x] `HELP` → `commands/help.ts` (`helpText(version)`, ohne bin-Selbstausführung testbar); `adopt`/`skip`/`doctor` raus aus der Befehlstabelle in eine Aliase-Fußnote; Ausgabe-Hinweise (status/doctor/sync) auf `add`/`remove` umgestellt. Back-Compat-Aliase (`adopt`/`skip`/`doctor`) erhalten.
- [x] Tests: runAdd (einrichten, husky-Override, Dry-Run, exit 2), manifestOverride-Treue; versionsneutraler ANSI-freier Hilfe-Snapshot.
- [x] committen + Review (zwei Agenten: Konventionen/Korrektheit + Bug-/Logik-Hunt) → keine Befunde ≥ Schwelle; Manifest-Persistenz, Dry-Run-Treue, Back-Compat & Snapshot bestätigt.

### WP7 — D2: `stack:update`-Script + Renovate  ✅ committet + reviewed
- [x] `scripts/stack-update.ts` (+ Root-`stack:update`): Registry-`fetch` je Catalog-Eintrag, Gate patch(default)/`--minor`/`--major` (numerisch gedeckelt, nie Downgrade), operator-erhaltendes Schreiben, `--dry-run`. Schreibt bei Teil-Fehlern gar nicht (kein inkonsistenter Zustand). `bun outdated -r` bleibt menschliche Sicht.
- [x] **Caveat verifiziert** (WP3): `bun outdated -r` zeigt named-Catalogs (`catalogs.svelte`) nicht — empirisch bestätigt, rechtfertigt das Script.
- [x] `renovate.json`: Catalog-Support verifiziert → Renovate kennt Bun-Catalogs **nicht nativ** (nur pnpm/yarn), daher Regex-`customManager` (RE2-tauglich; `renovate-config-validator`-geprüft, Extraktion gegen package.json verifiziert). `rangeStrategy: bump`, deps-scope, `@urbicon/*` ausgenommen. CLAUDE.md: Versions-Quelle (Catalog) + Bump-Workflow dokumentiert.
- [x] committen + Review (2 Agenten) → Befunde behoben: Renovate-customManager (native Lücke), kein Teil-Write bei Fehlern, robustere `splitRange`.

### WP8 — D8: `udx sync --install` (klein)
- [ ] `--install`-Flag → `bun install` nach erfolgreichem sync; Footer bietet es an.
- [ ] committen + Review.

### Defer / v2
- [ ] D9: Catalog-aware Consumer-Writes (`catalog:` + fremden Catalog pflegen) — eigener Plan.
- [ ] Docs/CLAUDE.md final über alle WPs konsolidieren (`docs-review`).

## Reihenfolge
WP1 → WP2 → WP3 → **WP4 + WP5** (Kern der UX) → WP6 → WP7 → WP8. D9 später.

## Rollback je WP
Jedes WP ist ein eigener Commit auf `feat/version-governance`; Reset via `git revert <sha>`
oder Branch-Drop. Phase 0 ist verhaltensgleich (Snapshot-Test sichert Byte-Identität).
