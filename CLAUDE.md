# @urbicon/udx — development harness

## Project overview

Shared dev harness for Bun/Svelte projects: configs, a `udx` CLI, and a
Claude plugin. Goal: **maintain a proven setup once** (Biome, Conventional Commits,
git-cliff, Lefthook, bump pipeline) and distribute it to projects instead of
copying — including `udx sync` to pull in improvements.

## Architecture

Bun workspace monorepo that **dogfoods its own configs** (root `biome.json`
extends `@urbicon/biome-config`, etc.).

| Package / folder             | Role                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| `packages/tsconfig`          | `@urbicon/tsconfig` — `base.json`, `svelte.json`            |
| `packages/biome-config`      | `@urbicon/biome-config` — shared `biome.json`              |
| `packages/commitlint-config` | `@urbicon/commitlint-config` — `createConfig({ scopes })`   |
| `packages/cli`               | `@urbicon/udx` — `init` / `sync` / `doctor`                  |
| `claude/`                    | Claude plugin (skills, e.g. `docs-review`)                  |

### Two kinds of building blocks (core concept)

1. **Extensible** → config packages; content lives in the package, updated via version bump.
2. **Must physically exist** (`cliff.toml`, `lefthook.yml`, `scripts/bump.sh`,
   `bunfig.toml`, `renovate.json`) → written by the CLI. File policies in
   `packages/cli/src/templates/index.ts`:
   - **managed** → 3-way sync via `.udx.json` hashes: untouched-stale files are pulled in by
     `udx sync`, locally modified ones are protected as a conflict (`--force` overwrites)
   - **create-only** → only created when missing (project adjustments are preserved)
   - **scope** `root` (default) vs `package`: in a monorepo, `package` building blocks
     (e.g. `tsconfig`) run per workspace package (Svelte detected per package), not at the root.
     Plain asset packages without TS code are skipped (`isTypeScriptPackage`).
     `package` building blocks must be `create-only` (otherwise manifest hashes collide)

### Capabilities (stack awareness)

`lib/capabilities.ts` bundles stack-specific building blocks (file + scripts + devDeps) into
declinable units (`git-hooks`→lefthook, `lint-format`→biome, `dep-updates`→renovate).
`supersededBy(ctx)` detects a competing stack **generically** (via deps/files, never via project
names) (husky, `core.hooksPath`/`.githooks`, eslint, dependabot, an own
Renovate config, …); the building block is then automatically declined and the decision
persisted in `.udx.json` `declined`. `udx adopt <id>` / `udx skip <id>` control this manually.
Declined building blocks are not a target in `init`/`sync`/`doctor` (not an error).

### CLI structure (`packages/cli/src`)

- `bin/udx.ts` — arg parsing + dispatch (zero runtime deps)
- `commands/harness.ts` — shared `init`/`sync` logic
- `commands/doctor.ts` — read-only drift check
- `commands/capability.ts` — `adopt`/`skip` (adopt/decline building blocks)
- `lib/` — `detect` (Svelte detection), `apply` (file engine + `bunfig.toml`),
  `manifest` (`.udx.json`: 3-way hashes + declined/adopted building blocks),
  `capabilities` (declinable stack bundles + conflict detection + `--only` resolution),
  `diff` (zero-dep LCS diff for `--diff`), `workspace` (monorepo packages via `Bun.Glob`),
  `pkg` (package.json patch), `versions` (pinned versions), `fs`/`log`/`colors`
- `templates/` — render functions; complex files (`cliff.toml`, `bump.sh`,
  `CLAUDE.md.tpl`) as text assets under `src/assets/` (imported via
  `with { type: 'text' }`, so that `${...}` in bump.sh does not collide with JS)

## Commands

```bash
bun install
bun --filter='@urbicon/udx' run build   # build CLI (bun build → dist/bin/udx.js)
bun --filter='@urbicon/udx' run test    # bun test
bun --filter='@urbicon/udx' run check   # tsc --noEmit
bun run lint                           # Biome (root)
bun run fix                            # Biome --write
```

Run the CLI locally without building: `bun run packages/cli/src/bin/udx.ts <command>`.

## Conventions

- **Stack decisions**: Biome (TS/JS/JSON), Prettier only for `.svelte` (hybrid),
  Lefthook, Conventional Commits + git-cliff. When changing templates, think of **both
  sides**: the asset/render **and** whether `init`/`sync`/`doctor` handle it
  correctly.
- **Biome rules** (`@urbicon/biome-config`): `recommended` + targeted additional rules
  (`noUnusedVariables`/`noShadow`/`useTopLevelRegex` = `error`, `useExplicitReturnType` =
  `warn`). Extend per policy: avoid nursery (unstable on consumer Biome upgrades →
  the one exception only as `warn`), drop pure style rules + Bun false positives (`Bun` global,
  `process`, node modules); test globs relax the strict/production-code-oriented rules
  (`useExplicitReturnType`, `useTopLevelRegex`, `noNonNullAssertion`,
  `noExplicitAny`) via `overrides` — tests may be more pragmatic (`!`/`any` for fixtures/mocks).
  Dogfooded ⇒ every new rule must have 0 findings (fix consumer code along with it, otherwise
  `bun run lint` breaks).
  (`workspaces.catalog` + `catalogs.svelte`) pinned centrally — the single source of
  truth. `versions.ts` only *reads* them and derives the consumer pins; `@urbicon/*`
  are unified with the CLI version (not in the catalog). The stack is bumped
  **separately from the release `bump.sh`**:
  - **Renovate** (default, `renovate.json`, `rangeStrategy: bump`). Renovate does **not**
    natively know Bun catalogs (unlike pnpm/yarn) → a regex `customManager`
    captures the catalog version strings; config verifiable with `renovate-config-validator`.
    The same config goes to consumers as a create-only building block (`dep-updates`, asset
    `src/assets/renovate.json.tpl` — byte-identical to the root file, coupled via a test;
    `.tpl` so that Biome does not reformat it).
  - manually `bun run stack:update [--minor|--major]` (default gate = patch only, writes
    operator-preserving, never downgrades, does nothing at all on errors).
  - `bun outdated -r` = read view, does **not** show named catalogs (`catalogs.svelte`) — hence the script.
- **Dogfooding**: the root configs use the own packages. After changes to a
  config package, check that the root setup still loads.

## Commits & releases

Conventional Commits, scopes: `cli`, `biome-config`, `commitlint-config`,
`tsconfig`, `claude`, `deps`. Release: `bun run bump[:minor|:major]` → version +
changelog (git-cliff) + annotated tag. Push with `git push --follow-tags`.

## Distribution

`@urbicon/*` → Codeberg's npm registry, **publicly readable** (no token to install; Bun
just needs the `@urbicon` scope → registry mapping, which `udx init` writes into
`bunfig.toml` `[install.scopes]`). Only **publishing** needs a token: `bun publish` reads
`$CODEBERG_TOKEN` from `.npmrc` (`:_authToken=$CODEBERG_TOKEN`) — Bun interpolates `$VAR`,
not `${VAR}`, and the file holds only the env reference, not a secret. Release: `bun run
bump` → `bun run release:publish` (config packages before the CLI). `versions.ts`
automatically derives the `@urbicon/*` pins from its own version.
Claude plugin → marketplace `.claude-plugin/marketplace.json` (repo root).
