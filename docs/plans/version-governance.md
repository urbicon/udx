# Plan: Version governance & consumer visibility

> Goal: **one** source for the prescribed stack (one bump propagates, no guards
> needed) and a consumer experience where you *see* the state, understand *what
> changes and how*, and *selectively* set up/sync/update with familiar verbs —
> with minimal onboarding.

## Guiding principle
The dev works with vocabulary they know from package managers (`init/status/sync/add/remove`),
sees the state instead of having to ask for it, and triggers risky actions only deliberately.

## Verified fundamentals (empirical, Bun 1.3.14)
- `bun build` inlines the root `package.json` via `../../../../` → `versions.ts` as a catalog reader runs standalone. ✅
- `bun outdated -r` shows catalog drift (the `catalog` column). ✅ — but **no `--json`** (the flag is ignored). ⚠️
- Unreferenced catalog entries are allowed, but ignored by `bun outdated` (→ Svelte needs a referencer). ✅
- Bun does **not** bump catalog entries automatically (`bun update` even un-catalogs them). ❌ → own update/Renovate.
- `bun pm pack` resolves `catalog:` (like `workspace:`) → publish-safe. ✅

## Decisions made (short form, details see the conversation)
- **D1** Source of truth = **Bun catalog** (a known mechanism, visible in `bun outdated`).
- **D2** Stack bump = **Renovate** (default) + dev script `stack:update` (registry `fetch`, since there's no `--json`); **no** CLI subcommand.
- **D3** Svelte gap = private **`packages/svelte-fixture`** (`catalog:svelte`, dogfood + smoke test).
- **D4** Visibility = **one engine**, `udx status` (human, default for bare `udx`) + `--ci`/`--json`; `doctor` as an alias. Grouped by building block, per line `[what you have]→[target]·classification·command`.
- **D5** Sync = **safe changes automatically** (add missing ones, raise versions that are *too old* — never a downgrade/above the ahead value), `--force`/`-i` only for locally modified files + script drift; **`udx pin/unpin`** for deliberate pinning.
- **D6** Selective = **`udx add/remove <building block>`** (the main path) + `sync -i` + `--only` (power users).
- **D7** Naming = dev-facing `init·status·sync·add·remove` (+`--only`,`pin`); `adopt/skip/doctor` as hidden aliases; jargon out of the output.
- **D8** `udx sync --install` opt-in (the footer offers it).
- **D9** Consumer writes literal (default); `catalog:` for catalog consumers as **v2**.
- **D10** Scope: udx governs the **tooling stack (root + per-package tsconfig)**, not app runtime deps.

---

## Work packages (each: implement → tests/check/lint → commit → review agent → fix findings)

### WP1 — Downgrade fix + pin alignment  ✅ committed + reviewed
- [x] `satisfiesPin()` in `pkg.ts`: pin = baseline, never a downgrade (semver-aware via `Bun.semver`).
- [x] Drift condition switched to `!satisfiesPin`.
- [x] Pins aligned (`@types/node ^25.9.2`, `@commitlint/cli ^21.0.2`, `lefthook ^1.13.6`).
- [x] Tests: `satisfiesPin`, drift regression, pin-lag guard.
- [x] commit + review → findings fixed (`floorVersion` skips upper bounds; protocol specifiers like `npm:`/git generically treated as satisfied).

### WP2 — Phase 0: catalog as the single source of truth (behavior-equivalent)  ✅ committed + reviewed
- [x] Root `package.json`: `workspaces.catalog` (+ `catalogs.svelte`) with **exactly** the current pin values; **all** udx packages (root, cli, commitlint-config) reference via `"catalog:"`.
- [x] `versions.ts`: constants → catalog reader; `DepName`/name groups exported, `pkg.ts` uses them (no duplication). A generic `pick<N>` keeps the precise key types.
- [x] Pin-lag guard test → **mirror + completeness test** + dogfooding test (all packages reference the catalog).
- [x] DoD: `VERSIONS` byte-identical (verified at runtime), suite green, `udx sync --dry-run` identical plan, dist carries the correct `^25.9.2`.
- [x] commit + review → finding (dogfooding untested) fixed. **npm safety guard dropped**: npm plays no role, `bun publish` resolves `catalog:` → `catalog:` stays even in published runtime deps (consistent). See memory `bun-only-no-npm`.

### WP3 — Phase 1: `svelte-fixture`  ✅ committed + reviewed
- [x] `packages/svelte-fixture/package.json` (private, `catalog:svelte`) + a mini `.svelte` + a `check` script (prettier with the exactly prescribed `.prettierrc`/`.prettierignore` + `svelte-check`, runs in the gate).
- [x] Ensure: udx dogfooding does not force any unwanted building blocks onto the fixture (reviewer confirmed: tsconfig create-only → skip, publish.sh does not list them).
- [x] The udx root `biome.json` ignores `.svelte` (locally only; the published `biome-base` untouched).
- [x] commit + review → finding (prettier scope) fixed (`.prettierignore`). _Caveat:_ `bun outdated` may not show named catalogs (`catalogs.svelte`) — verify in WP7.

### WP4 — D4: `udx status` (visibility) + classification engine  ✅ committed + reviewed
- [x] Classification (in sync✓ / behind↑ / customized✎ / missing+ / pinned⊙ / declined⊘) derived from `computePkgPlan` + `applyFiles` dry-run.
- [x] `commands/status.ts`: table grouped by building block/files/package.json/Registry, a command per line; legend + summary; `--json`.
- [x] `bin/udx.ts`: `status` command + bare `udx` → status; `doctor` stays the CI variant (exit codes), shares the engines.
- [x] Tests for classification (`buildReport`) + runStatus smoke test.
- [x] commit + review → findings (string match, try/catch, redundant read, in-sync counting) fixed.

### WP5 — D5: safe sync semantics + `pin/unpin`  ✅ committed + reviewed
- [x] `mutatePkg`: apply `devDepsDrift`(=behind) in the **non-force** path (never a downgrade); `scriptsDrift` stays force-only.
- [x] Manifest: `pinned: Record<dep, range>`; `computePkgPlan` respects pins (no drift/add) but reports them (missing ones too → never silent).
- [x] `commands/pin.ts` (+ `bin`): `udx pin <dep> [range]` / `udx unpin <dep>`.
- [x] `harness`/`doctor` show pinned deps; drift = "sync bumps" (no force nag).
- [x] Tests: auto pull-up without force, pin holds, unpin releases, pinned-absent reported.
- [x] commit + review → findings (pinned-missing silent; unnecessary roundtrip) fixed.

### WP6 — D6/D7: `add`/`remove` + naming aliases  ✅ committed
- [x] `add` (= adopt + a targeted `sync --only`, overrides auto-decline, dry-run-faithful via the passed-through `manifestOverride`) / `remove` (= decline, files stay) as dev-facing verbs; `status` the primary name.
- [x] `HELP` → `commands/help.ts` (`helpText(version)`, testable without the bin self-executing); `adopt`/`skip`/`doctor` moved out of the command table into an aliases footnote; output hints (status/doctor/sync) switched to `add`/`remove`. Back-compat aliases (`adopt`/`skip`/`doctor`) preserved.
- [x] Tests: runAdd (set up, husky override, dry-run, exit 2), manifestOverride fidelity; version-neutral, ANSI-free help snapshot.
- [x] commit + review (two agents: conventions/correctness + bug/logic hunt) → no findings ≥ threshold; manifest persistence, dry-run fidelity, back-compat & snapshot confirmed.

### WP7 — D2: `stack:update` script + Renovate  ✅ committed + reviewed
- [x] `scripts/stack-update.ts` (+ root `stack:update`): registry `fetch` per catalog entry, gate patch(default)/`--minor`/`--major` (numerically capped, never a downgrade), operator-preserving writes, `--dry-run`. Writes nothing at all on partial errors (no inconsistent state). `bun outdated -r` stays the human view.
- [x] **Caveat verified** (WP3): `bun outdated -r` does not show named catalogs (`catalogs.svelte`) — empirically confirmed, justifies the script.
- [x] `renovate.json`: catalog support verified → Renovate does **not** know Bun catalogs natively (only pnpm/yarn), hence a regex `customManager` (RE2-compatible; checked with `renovate-config-validator`, extraction verified against package.json). `rangeStrategy: bump`, deps scope, `@urbicon-ui/*` excluded. CLAUDE.md: version source (catalog) + bump workflow documented.
- [x] commit + review (2 agents) → findings fixed: Renovate customManager (native gap), no partial write on errors, more robust `splitRange`.

### WP8 — D8: `udx sync --install` (small)  ✅ committed + reviewed
- [x] `--install` (init/sync/add) → `bun install` after a successful run, but only on installable changes (a pure `installPlan`); without the flag the footer offers it specifically (no longer blanket). `patchPkg` reports `pkgChanged`; `installDeps` via `Bun.spawnSync`.
- [x] commit + review (2 agents) → findings fixed: spawn throw (bun not in $PATH) caught; honest error message (a prepare failure ≠ a dep failure). Exit 1 only on a requested + failed install.

## Addenda (real-world usage feedback)

### Biome × Svelte  ✅ committed
- [x] The generated `biome.json` **always** excludes `.svelte` (not only when Svelte is detected) — otherwise the non-svelte monorepo root lets Biome run inside `.svelte` sub-packages (false positives/fixes). Svelte stays with Prettier (format) + svelte-check (types/a11y); Biome only TS/JS/JSON. The optional ESLint Svelte building block is deferred (an opt-in extra).

### WP9 — Wiring awareness for @urbicon-ui config packages  ✅ committed + reviewed
> Problem (real-world): create-only configs that already exist (`tsconfig.root.json` self-contained, `commitlint.config.mjs` uses `config-conventional` directly) are not wired — yet `@urbicon-ui/tsconfig`/`commitlint-config` are still added as a devDep ⇒ dead weight. Dep and usage decoupled.
- [x] `lib/wiring.ts`: detects per @urbicon-ui config package (`biome-config`/`commitlint-config`/`tsconfig`) whether the consuming config references it → `wired` / `self-managed` / `absent` (tsconfig scans the root + workspace packages; robust string match because of jsonc/.mjs; aggregate: one wired candidate is enough).
- [x] **Dep gating:** `self-managed` ⇒ the @urbicon-ui dep is **not** added (only the preset dep, not the tool dep like `@biomejs/biome`). Self-healing, no manifest state — follows the real config; after wiring, the next `sync` adds the dep.
- [x] **Actively report** in `status` (the "Wiring" section, `~` glyph), `doctor` (skip, no fail), `sync` footer: "own <config> — @urbicon-ui/<pkg> not wired". Choice: adopt with `udx sync --only <id> --force` · keep your own (do nothing).
- [x] **Decision A:** no capability/`add`/`remove` for this — the dep follows the *actual wiring* (config content), orthogonal to the adopt/decline manifest.
- [x] **Decision B (semantics extension):** `applyFiles` overwrites a create-only file **only** with `--force` **and** an explicit `--only <id>`. A bare `udx sync --force` leaves create-only files untouched.
- [x] Tests + commit + review (2 agents) → finding fixed: `udx add <cap> --force` is additive (no create-only overwrite; deliberate replacement only via `sync --only --force`).

### Defer / v2
- [x] D9: Catalog-aware consumer writes (`catalog:` + maintain a foreign catalog) + per-package Svelte deps
  → own plan [d9-catalog-aware.md](d9-catalog-aware.md), implemented (WP1–WP4, branch
  `feat/catalog-aware-writes`).
- [ ] Finalize docs/CLAUDE.md consolidation over all WPs (`docs-review`).

## Order
WP1 → WP2 → WP3 → **WP4 + WP5** (the core of the UX) → WP6 → WP7 → WP8. D9 later.

## Rollback per WP
Each WP is its own commit on `feat/version-governance`; reset via `git revert <sha>`
or a branch drop. Phase 0 is behavior-equivalent (a snapshot test ensures byte-identity).
