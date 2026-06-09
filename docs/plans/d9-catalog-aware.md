# Plan: D9 — Catalog-aware Consumer-Writes + per-Paket-Deps  ✅ umgesetzt

> Fortsetzung von [version-governance.md](version-governance.md) (dortiges Defer-Item D9).
> Branch `feat/catalog-aware-writes`. Alle WPs committet + per Review-Agenten geprüft.

## Context

`udx init`/`udx sync` schrieb **literale** Tool-Versionen (aus dem udx-Catalog via `VERSIONS`)
**nur in die Root-`package.json`** des Consumers. Zwei Probleme:

1. **Idiom-Bruch:** Ein Catalog-First-Consumer (eigener `workspaces.catalog`) bekam udx' Tool-
   Versionen als literale Ausreißer neben seinem sonst sauberen Catalog.
2. **Svelte-Monorepo-Gap:** Ein Svelte-Sub-Paket unter nicht-svelte Root bekam **weder** Svelte-
   devDeps **noch** Svelte-Lint/Format-Script (`canonicalDevDeps(rootCtx)` sah den Root als nicht-svelte).

**Ergebnis:** udx erkennt einen Catalog-First-Consumer und fügt sich ein (Tool-Versionen in den
Catalog, `catalog:` statt literal, nie Downgrade) **und** schreibt Svelte-Deps/Scripts je Svelte-Paket.

## Verifizierte Grundlagen (empirisch, Bun 1.3.14)

- `catalog:` löst auch im **Single-Package** mit eigenem `workspaces.catalog` auf (braucht keine Sub-Pakete). ✅
- `catalog:` auf einen **fehlenden** Eintrag ⇒ `bun install` bricht hart (`failed to resolve`). ⚠️ ⇒ Eintrag + devDep **atomar**.
- Benannte Catalogs (`catalog:svelte`) funktionieren ebenso. ✅
- `workspaces` in **Array-Form** kann **kein** `catalog:` — nur Objekt-Form mit `catalog`. ⇒ Auto-Detect-Trigger.
- E2E verifiziert: tmp-Catalog-Monorepo → `udx init` → `bun install` löst alle `catalog:`-Specifier auf, Lockfile geschrieben.

## Getroffene Entscheidungen

- **D9-A Trigger = Auto-Detect.** Catalog-Modus aktiv ⇔ Root hat `workspaces.catalog`/`catalogs`
  (`readCatalogTables !== null`). Kein Flag, kein Manifest-State — folgt der Realität wie das WP9-Wiring.
- **D9-B Tabellenwahl = minimal-invasiv.** Dep bereits in einer Catalog-Tabelle → diese pflegen +
  passendes `catalog:`/`catalog:<name>`. Sonst → Default-Catalog. Benannte Catalogs werden nie erzeugt.
- **D9-C Platzierung (Tiers):** *root* (repo-globale Tools + TS-Toolchain + nicht-svelte Lint/Format) am
  Root; *svelte* (SVELTE_DEPS + svelte-flavored Lint/Format) je Svelte-Paket. **Nicht-svelte-TS-Pakete
  bekommen keine eigenen devDeps** (Bun-Hoisting; hält den Blast-Radius auf Svelte-Pakete begrenzt).
- **D9-D `@urbicon/*` bleiben immer literal** (`^${CLI_VERSION}`, unified mit der CLI-Version; nie im Catalog).
- **D9-E Nie-Downgrade.** Catalog-Eintrag = Maximum aus (Catalog-Wert, **allen** literalen devDep-
  Vorkommen über alle Pakete, Pin), Operator erhalten (`raise`). Akkumulation über ein geteiltes,
  über alle Paket-Patches gefädeltes Catalog-Arbeitsobjekt; das Root-pkg wird genau einmal geschrieben.

**Scope-Grenzen:** keine named-Catalog-Erzeugung; keine Array→Objekt-Migration der `workspaces`; keine
per-Paket-devDeps für Nicht-svelte-TS-Pakete; kein `--catalog`-Flag; keine Root-Orchestrierung der
Paket-Scripts (`bun --filter`).

## Arbeitspakete

### WP1 — Per-Paket-Svelte-Tier (literal, ohne Catalog)  ✅ committet (`1f5863f`) + reviewed
- [x] `pkg.ts`: `DepTier` (`root`/`svelte`); `canonicalDevDeps`/`canonicalScripts`/`computePkgPlan` nach Tier geschnitten (ohne Tier = bisheriges Verhalten).
- [x] `harness.ts`: `patchPkg` je Svelte-Sub-Paket (`tier:'svelte'`), Root `tier:'root'` (svelte-Root/Single-Package = alles).
- [x] `status`/`doctor`: per-Svelte-Paket-Plan gemeldet.
- [x] Review (2 Agenten): keine Bugs/Regression; nur kosmetische Notizen (für WP4 konsolidiert).

### WP2 — Catalog-Read-Modell + Plan-Arrays (pure)  ✅ committet (`f842e24`) + reviewed
- [x] `lib/catalog.ts`: `readCatalogTables` (Trigger), `selectCatalogTable` (D9-B). `pkg.ts`: `raise` (operator-erhaltend, nie Downgrade), `isVersionRange`.
- [x] `PkgPlan` +3 Arrays (`catalogEntriesToAdd`/`Drift`/`devDepsToCatalog`); `computePkgPlan(…, catalog)`: @urbicon literal, Pin vor Catalog-Logik, Drift am Tabellen-Wert, Atomaritäts-Invariante.
- [x] Review → Befund behoben: `raise` härtet Compound-/führende-`<`-Ranges (nutzt den Pin statt einer kaputten Range), erhält Build-Metadaten.

### WP3 — Atomare Catalog-Writes + Root-pkg-Verdrahtung  ✅ committet (`917a8a9`) + reviewed
- [x] `mutatePkg`: devDep→`catalog:`-Switch (non-force). `applyCatalogEntries`: Akkumulation am geteilten Catalog-Objekt (D9-E); `wireCatalog`: einmal ins Root-pkg.
- [x] `runHarness`: ein `PatchShared` durch Root- + Svelte-Paket-Patches; jedes Sub-pkg einzeln, Root-pkg genau einmal geschrieben.
- [x] E2E (echtes `bun install`) + Tests (Atomaritäts-Invariante, zwei Svelte-Pakete → Maximum, Idempotenz, Array-Form literal).
- [x] Review (2 Agenten): keine Korrektheitsfehler über alle 9 Fehlerklassen; Test-Lücken (benannter Catalog, gepinnter Dep) geschlossen.

### WP4 — status/doctor Catalog-Reporting + geteilter Helfer  ✅ committet (`cd16e85`) + reviewed
- [x] `lib/targets.ts`: `resolveWorkspaceView` (catalog/rootTier/tsPkgs an einer Stelle) + `planWorkspace` (Pläne aller Ziele **mit** Catalog-Akkumulation, read-only auf einer Kopie).
- [x] `status`: „Catalog"-Sektion + `catalog:`-Switch-Zeilen. `doctor`: fehlender Eintrag → fail, Drift/Switch → warn.
- [x] Review (2 Agenten) → zwei Befunde behoben: (1) `inSync`-Doppelzählung eines Switch-Deps; (2) falsches Drift-Ziel ohne Akkumulation → `planWorkspace` simuliert sie. Beide mit Regressionstest.

## Edge-Cases (Soll-Verhalten)

| Fall | Verhalten |
|---|---|
| Array-Form `workspaces` (kein Catalog möglich) | literal-Modus; per-Paket-Svelte trotzdem → Gap geschlossen ohne Catalog. |
| Catalog + Single-Package | Catalog-Modus an, Paket-Schleife leer. |
| Dep im Catalog, devDep literal/abweichend | Switch + Eintrag-Floor auf ≥ literal anheben → nie Downgrade. |
| Gepinnter Dep (`udx pin`) | Vor jeder Catalog-Logik: nicht geswitcht, kein Eintrag, als „gehalten" gemeldet. |
| `--force` | Catalog add/drift/Switch bleiben non-force; ein Catalog-Downgrade ist nie erreichbar. |

## Offen / nächster Schritt

- Docs/CLAUDE.md final über D9 + alle WPs konsolidieren (`docs-review`) — das verbleibende v2-Thema.
