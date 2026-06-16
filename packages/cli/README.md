# @urbicon/udx

CLI for setting up and **synchronizing** the urbicon development harness in
Bun/Svelte projects. Writes the non-extensible files (cliff.toml,
Lefthook hooks, bump.sh, bunfig.toml, renovate.json) and wires up the extensible config packages
(`@urbicon/biome-config`, `@urbicon/commitlint-config`, `@urbicon/tsconfig`).

## Installation

```bash
# Prerequisite: @urbicon scope set globally in ~/.bunfig.toml (public registry — no token)
bun add -g @urbicon/udx
```

Local development from this repo:

```bash
cd packages/cli && bun link        # make available globally
# or directly:  bun run packages/cli/src/bin/udx.ts <command>
```

## Commands

| Command         | Purpose                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `udx init`      | Set up the harness in a project (auto-detection Svelte vs. plain TS)     |
| `udx sync`      | Update managed files — **pull in process improvements**                  |
| `udx doctor`    | Read-only: check for missing/diverging parts (exit code 1 on problems)   |
| `udx adopt <id>`| Re-adopt a declined building block (overrides the auto-decline)          |
| `udx skip <id>` | Permanently decline a building block (own stack — e.g. husky over lefthook) |

### Options

| Flag                | Effect                                                                   |
| ------------------- | ------------------------------------------------------------------------ |
| `-n, --dry-run`     | write nothing, preview only                                             |
| `-f, --force`       | also overwrite locally modified `managed` files & package.json drift     |
| `-i, --interactive` | decide per file on conflicts (update/skip/diff)                          |
| `--only <ids>`      | only these building blocks (capability or file ids, comma-separated)     |
| `--diff`            | on drift, show the difference local → template                          |
| `--svelte` / `--no-svelte` | force Svelte setup / force plain TS setup                         |
| `--cwd <path>`      | target directory (default: current)                                     |

## File policies

- **managed** (`cliff.toml`, `lefthook.yml`, `scripts/bump.sh`): **3-way sync** via
  the hashes remembered in `.udx.json`. Untouched-stale files are pulled in by `udx sync`
  (improvements flow back); **locally modified** files are protected as a conflict
  (`--force` applies, `--diff` shows the difference, `--interactive` asks).
- **create-only** (`biome.json`, `tsconfig.json`, `commitlint.config.mjs`,
  `.prettierrc`*, `.gitignore`, `renovate.json`, `CLAUDE.md`): only created when they are missing —
  project adjustments are preserved. Content updates come through the
  config packages (version bump).

(* Svelte projects only.)

`bunfig.toml` is handled **additively**: if the `@urbicon` scope is missing, it is
added (or the file is created); an already-present `[install.scopes]` block
is not touched — instead the line to be added is reported.

`package.json` is patched idempotently: missing scripts/devDeps are added;
diverging values are left as-is and reported (`--force` overwrites).

## Stack awareness (capabilities)

Stack-specific building blocks are bundled into **capabilities** and are automatically
declined when udx detects a competing stack — without project hardcoding:

| Capability    | Building blocks        | declined when            |
| ------------- | ---------------------- | ----------------------------- |
| `git-hooks`   | lefthook + prepare     | husky / `.husky/` / simple-git-hooks / `core.hooksPath` (`.githooks/`) |
| `lint-format` | biome + lint/format/fix | eslint                       |
| `dep-updates` | renovate.json          | dependabot / own Renovate config (different location or package.json key) |

Declined building blocks are not a target (no `doctor` error); the decision is persisted in
`.udx.json`. Migration: `udx adopt git-hooks && udx sync --only git-hooks`.

## Monorepo

In the workspace monorepo (array or object form, including Bun catalogs) root building blocks run
once at the root; `tsconfig` is created per TS package (Svelte detected per package, plain
asset packages skipped). The project-specific root `tsconfig` is left untouched.

## Manifest (`.udx.json`)

udx writes a versioned manifest that belongs in git, containing: the most recently written
file hashes (3-way drift), declined (`declined`) and adopted (`adopted`)
capabilities. Hand-editable; corrupt entries are tolerantly ignored.
