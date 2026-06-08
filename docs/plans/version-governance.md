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

### WP1 — Downgrade-Fix + Pin-Angleichung  ✅ (umgesetzt, noch zu committen)
- [x] `satisfiesPin()` in `pkg.ts`: Pin = Baseline, nie Downgrade (semver-bewusst via `Bun.semver`).
- [x] Drift-Bedingung auf `!satisfiesPin` umgestellt.
- [x] Pins angeglichen (`@types/node ^25.9.2`, `@commitlint/cli ^21.0.2`, `lefthook ^1.13.6`).
- [x] Tests: `satisfiesPin`, Drift-Regression, Pin-Lag-Guard.
- [ ] committen + Review.

### WP2 — Phase 0: Catalog als Single Source of Truth (verhaltensgleich)
- [ ] Root-`package.json`: `workspaces.catalog` (+ `catalogs.svelte`) mit **exakt** den aktuellen Pin-Werten; überlappende eigene devDeps auf `"catalog:"`.
- [ ] `versions.ts`: Konstanten → Reader (`{...catalog, ...catalogs.svelte}` + `@urbicon/* = SELF`). `DepName` als explizite Namensliste führen (Spread verliert Literaltypen).
- [ ] Pin-Lag-Guard-Test → **Completeness-Test** (jeder `DepName` hat einen Catalog-Eintrag).
- [ ] DoD: `VERSIONS` byte-identisch (Snapshot-Test), Suite grün, `udx sync --dry-run` gegen Fixture identischer Plan.
- [ ] committen + Review.

### WP3 — Phase 1: `svelte-fixture`
- [ ] `packages/svelte-fixture/package.json` (private, `catalog:svelte`) + Mini-`.svelte` + `check`-Script.
- [ ] Sicherstellen: udx-Dogfooding zwingt der Fixture keine ungewollten Bausteine auf (`isTypeScriptPackage`/Svelte-Erkennung prüfen).
- [ ] committen + Review.

### WP4 — D4: `udx status` (Sichtbarkeit) + Klassifikations-Engine
- [ ] Gemeinsame Klassifikation (in sync / behind↑ / ahead⟳ / customized✎ / missing+ / pinned⊙ / declined⊘) aus `computePkgPlan` + `applyFiles`-Dry ableiten.
- [ ] `commands/status.ts`: nach Baustein gruppierte Tabelle, pro Zeile Befehl; `--json`/`--ci`.
- [ ] `bin/udx.ts`: `status`-Command + bare `udx` → status; `doctor` ruft dieselbe Engine (`--ci`).
- [ ] Tests für Klassifikation + Rendering (color:false).
- [ ] committen + Review.

### WP5 — D5: sichere Sync-Semantik + `pin/unpin`
- [ ] `harness`/`mutatePkg`: `devDepsToAdd` + `devDepsDrift`(=behind) im **Nicht-Force**-Pfad anwenden; `scriptsDrift` bleibt Force-only.
- [ ] Manifest: `pinned: Record<dep, range>`; `computePkgPlan` respektiert Pins (kein Drift/Add).
- [ ] `commands/pin.ts` (+ `bin`): `udx pin <dep> [range]` / `udx unpin <dep>`.
- [ ] Footer/Status zeigen gehaltene Deps.
- [ ] Tests: Auto-Pull-up ohne Force, Pin hält, unpin löst.
- [ ] committen + Review.

### WP6 — D6/D7: `add`/`remove` + Naming-Aliase
- [ ] `add`/`remove` als Dev-facing Verben (über `adopt`/`skip` + scoped sync); `status` als Primärname, `doctor` Alias.
- [ ] Hilfe/`HELP` aktualisieren; Back-Compat-Aliase erhalten.
- [ ] Tests + Hilfe-Snapshot.
- [ ] committen + Review.

### WP7 — D2: `stack:update`-Script + Renovate
- [ ] `scripts/stack-update.ts`: Registry-`fetch` je Catalog-Eintrag, `--minor`/`--major`-Gate, schreibt Catalog. (`bun outdated -r` bleibt menschliche Sicht.)
- [ ] `renovate.json` (Catalog-Support verifizieren) + Doku im CLAUDE.md (Bump-Workflow).
- [ ] committen + Review.

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
