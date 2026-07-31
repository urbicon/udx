# Plan: D9 — Catalog-aware consumer writes + per-package deps  ✅ implemented

> Continuation of [version-governance.md](version-governance.md) (its defer item D9).
> Branch `feat/catalog-aware-writes`. All WPs committed + checked by review agents.

## Context

`udx init`/`udx sync` wrote **literal** tool versions (from the udx catalog via `VERSIONS`)
**only into the consumer's root `package.json`**. Two problems:

1. **Idiom break:** A catalog-first consumer (own `workspaces.catalog`) got udx' tool
   versions as literal outliers next to its otherwise clean catalog.
2. **Svelte monorepo gap:** A Svelte sub-package under a non-svelte root got **neither** Svelte
   devDeps **nor** a Svelte lint/format script (`canonicalDevDeps(rootCtx)` saw the root as non-svelte).

**Result:** udx detects a catalog-first consumer and fits in (tool versions into the
catalog, `catalog:` instead of literal, never a downgrade) **and** writes Svelte deps/scripts per Svelte package.

## Verified fundamentals (empirical, Bun 1.3.14)

- `catalog:` also resolves in a **single package** with its own `workspaces.catalog` (needs no sub-packages). ✅
- `catalog:` pointing at a **missing** entry ⇒ `bun install` fails hard (`failed to resolve`). ⚠️ ⇒ entry + devDep **atomic**.
- Named catalogs (`catalog:svelte`) work the same way. ✅
- `workspaces` in **array form** cannot use `catalog:` — only the object form with `catalog` can. ⇒ auto-detect trigger.
- E2E verified: tmp catalog monorepo → `udx init` → `bun install` resolves all `catalog:` specifiers, lockfile written.

## Decisions made

- **D9-A trigger = auto-detect.** Catalog mode active ⇔ root has `workspaces.catalog`/`catalogs`
  (`readCatalogTables !== null`). No flag, no manifest state — follows reality like the WP9 wiring.
- **D9-B table choice = minimally invasive.** Dep already in a catalog table → maintain that one +
  the matching `catalog:`/`catalog:<name>`. Otherwise → default catalog. Named catalogs are never created.
- **D9-C placement (tiers):** *root* (repo-global tools + TS toolchain + non-svelte lint/format) at the
  root; *svelte* (SVELTE_DEPS + svelte-flavored lint/format) per Svelte package. **Non-svelte TS packages
  get no own devDeps** (Bun hoisting; keeps the blast radius limited to Svelte packages).
- **D9-D `@urbicon-ui/*` always stay literal** (`^${CLI_VERSION}`, unified with the CLI version; never in the catalog).
- **D9-E never downgrade.** Catalog entry = maximum of (catalog value, **all** literal devDep
  occurrences across all packages, pin), operator preserved (`raise`). Accumulation via a shared
  catalog working object threaded through all package patches; the root pkg is written exactly once.

**Scope boundaries:** no named-catalog creation; no array→object migration of `workspaces`; no
per-package devDeps for non-svelte TS packages; no `--catalog` flag; no root orchestration of the
package scripts (`bun --filter`).

## Work packages

### WP1 — Per-package Svelte tier (literal, no catalog)  ✅ committed (`1f5863f`) + reviewed
- [x] `pkg.ts`: `DepTier` (`root`/`svelte`); `canonicalDevDeps`/`canonicalScripts`/`computePkgPlan` sliced by tier (no tier = previous behavior).
- [x] `harness.ts`: `patchPkg` per Svelte sub-package (`tier:'svelte'`), root `tier:'root'` (svelte root/single package = everything).
- [x] `status`/`doctor`: per-Svelte-package plan reported.
- [x] Review (2 agents): no bugs/regression; only cosmetic notes (consolidated for WP4).

### WP2 — Catalog read model + plan arrays (pure)  ✅ committed (`f842e24`) + reviewed
- [x] `lib/catalog.ts`: `readCatalogTables` (trigger), `selectCatalogTable` (D9-B). `pkg.ts`: `raise` (operator-preserving, never a downgrade), `isVersionRange`.
- [x] `PkgPlan` +3 arrays (`catalogEntriesToAdd`/`Drift`/`devDepsToCatalog`); `computePkgPlan(…, catalog)`: @urbicon-ui literal, pin before catalog logic, drift against the table value, atomicity invariant.
- [x] Review → finding fixed: `raise` hardens compound/leading-`<` ranges (uses the pin instead of a broken range), preserves build metadata.

### WP3 — Atomic catalog writes + root-pkg wiring  ✅ committed (`917a8a9`) + reviewed
- [x] `mutatePkg`: devDep→`catalog:` switch (non-force). `applyCatalogEntries`: accumulation on the shared catalog object (D9-E); `wireCatalog`: once into the root pkg.
- [x] `runHarness`: one `PatchShared` through root + Svelte package patches; each sub-pkg individually, root pkg written exactly once.
- [x] E2E (real `bun install`) + tests (atomicity invariant, two Svelte packages → maximum, idempotency, array form literal).
- [x] Review (2 agents): no correctness errors across all 9 error classes; test gaps (named catalog, pinned dep) closed.

### WP4 — status/doctor catalog reporting + shared helper  ✅ committed (`cd16e85`) + reviewed
- [x] `lib/targets.ts`: `resolveWorkspaceView` (catalog/rootTier/tsPkgs in one place) + `planWorkspace` (plans for all targets **with** catalog accumulation, read-only on a copy).
- [x] `status`: "Catalog" section + `catalog:` switch lines. `doctor`: missing entry → fail, drift/switch → warn.
- [x] Review (2 agents) → two findings fixed: (1) `inSync` double-counting of a switch dep; (2) wrong drift target without accumulation → `planWorkspace` simulates it. Both with a regression test.

## Edge cases (target behavior)

| Case | Behavior |
|---|---|
| Array-form `workspaces` (no catalog possible) | literal mode; per-package Svelte nonetheless → gap closed without a catalog. |
| Catalog + single package | catalog mode on, package loop empty. |
| Dep in the catalog, devDep literal/divergent | switch + raise the entry floor to ≥ literal → never a downgrade. |
| Pinned dep (`udx pin`) | Before any catalog logic: not switched, no entry, reported as "pinned". |
| `--force` | catalog add/drift/switch stay non-force; a catalog downgrade is never reachable. |

## Open / next step

- Finalize docs/CLAUDE.md consolidation over D9 + all WPs (`docs-review`) — the remaining v2 topic.
