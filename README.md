# @urbicon-ui/udx

Shared **development harness** for Bun and Svelte/SvelteKit projects. One place
for configs, tooling, and Claude skills that used to be copied between projects by
hand — including a mechanism to **feed improvements back**.

## What's inside

| Package / folder             | Role                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `@urbicon-ui/tsconfig`          | TypeScript base config (`base.json` + `svelte.json`)                |
| `@urbicon-ui/biome-config`      | Biome formatter + linter (replaces Prettier + ESLint for TS/JS/JSON) |
| `@urbicon-ui/commitlint-config` | Conventional Commits with a scope factory                           |
| `@urbicon-ui/udx` (CLI)          | `udx init` / `udx sync` / `udx doctor` — distributes & updates everything |

## Two kinds of building blocks

1. **Extensible** (Biome, commitlint, tsconfig) → as packages; update via
   `bun update`. The content lives centrally in the package.
2. **Must physically exist** (`cliff.toml`, `lefthook.yml`, `scripts/bump.sh`,
   `renovate.json`) → written/updated by the `udx` CLI. `udx sync`
   pulls in changes.

## Opt-in: the knowledge layer

`udx add knowledge` installs a Claude Code skill that decides where a project's knowledge
lives and how it retires. It covers:

- instructions (`AGENTS.md`/`CLAUDE.md`), docs and `DECISIONS.md`;
- plans and working documents, which are harvested and deleted rather than archived;
- one tracker per project, and agent memory.

It also wires `bun run docs:check` (`udx docs check`), the gate for everything in that layer
that can be checked mechanically. The capability is opt-in: `init` and `sync` never add it on
their own. Details: [packages/cli/README.md](packages/cli/README.md#knowledge-layer-udx-add-knowledge).

## Quick start in a project

The `@urbicon-ui/*` packages are published to the **public npm registry** — nothing to
configure, no token to install:

```bash
# 1. Set up the harness
bunx @urbicon-ui/udx init        # or: udx init (globally installed)
bun install                   # deps + git hooks (via prepare script)

# 2. Pull in improvements later
udx sync --dry-run            # preview
udx sync                      # apply (--force also updates devDep pins)
udx doctor                    # check drift
```

## Stack decisions

- **Biome instead of Prettier+ESLint** for TS/JS/JSON/JSONC.
- **Svelte hybrid**: `.svelte` uses Prettier (`prettier-plugin-svelte`), Biome
  ignores `.svelte`; Svelte types via `svelte-check`.
- **Lefthook** as the git hook manager (a single `lefthook.yml` instead of `.husky/`).
- **Conventional Commits → git-cliff → changelog**, releases via `scripts/bump.sh`.
- **Renovate** for dependency updates (`renovate.json`, incl. Bun catalog support) —
  the app stack (vite, svelte, …) deliberately stays the project's concern; udx only
  pins its own tooling.

## Developing on this repo

```bash
bun install
bun --filter='@urbicon-ui/udx' run build   # build the CLI
bun --filter='@urbicon-ui/udx' run test    # test the CLI
bun run lint                           # Biome
```

## Publishing (npm)

The `@urbicon-ui/*` packages are published to the public npm registry. Installing needs
no token; only **publishing** does — an `NPM_TOKEN` (automation token with publish
rights for the `@urbicon-ui` scope) in the environment or a gitignored `.env`. `bun
publish` reads it from `.npmrc` (`…:_authToken=$NPM_TOKEN`) — the file holds only the
env reference, no secret. Scoped packages go out public via `publishConfig.access`.

```bash
# 1. Prepare the release (version + changelog + tag, unified across all packages)
bun run bump                    # or bump:minor / bump:major

# 2. Preview, then publish (config packages before the CLI; the CLI builds dist/ via prepublishOnly)
bun run release:publish --dry-run
bun run release:publish

# 3. Push tags
git push --follow-tags
```
