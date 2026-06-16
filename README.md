# @urbicon/udx

Shared **development harness** for Bun and Svelte/SvelteKit projects. One place
for configs, tooling, and Claude skills that used to be copied between projects by
hand — including a mechanism to **feed improvements back**.

## What's inside

| Package / folder             | Role                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `@urbicon/tsconfig`          | TypeScript base config (`base.json` + `svelte.json`)                |
| `@urbicon/biome-config`      | Biome formatter + linter (replaces Prettier + ESLint for TS/JS/JSON) |
| `@urbicon/commitlint-config` | Conventional Commits with a scope factory                           |
| `@urbicon/udx` (CLI)          | `udx init` / `udx sync` / `udx doctor` — distributes & updates everything |
| `claude/`                    | Claude Code plugin (skills such as `docs-review`)                   |

## Two kinds of building blocks

1. **Extensible** (Biome, commitlint, tsconfig) → as packages; update via
   `bun update`. The content lives centrally in the package.
2. **Must physically exist** (`cliff.toml`, `lefthook.yml`, `scripts/bump.sh`,
   `bunfig.toml`, `renovate.json`) → written/updated by the `udx` CLI. `udx sync`
   pulls in changes.

## Quick start in a project

The `@urbicon/*` packages live in Codeberg's **public** npm registry — no token
needed to install. Bun only needs to know which registry serves the `@urbicon`
scope. Set it once per machine in `~/.bunfig.toml`:

```toml
[install.scopes]
"@urbicon" = "https://codeberg.org/api/packages/urbicon/npm/"
```

Then, in any project:

```bash
# 1. Set up the harness — also writes a project-local bunfig.toml with the scope
bunx @urbicon/udx init        # or: udx init (globally installed)
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
bun --filter='@urbicon/udx' run build   # build the CLI
bun --filter='@urbicon/udx' run test    # test the CLI
bun run lint                           # Biome
```

## Publishing (Codeberg registry)

The `@urbicon/*` packages are published to Codeberg's npm registry. They are
**publicly readable** (no token to install); only **publishing** needs a
`CODEBERG_TOKEN` (a Forgejo PAT with scope `package: read+write`) in the
environment or a gitignored `.env`. `bun publish` reads it from `.npmrc`
(`…:_authToken=$CODEBERG_TOKEN`) — the file holds only the env reference, no secret.

```bash
# 1. Prepare the release (version + changelog + tag, unified across all packages)
bun run bump                    # or bump:minor / bump:major

# 2. Preview, then publish (config packages before the CLI; the CLI builds dist/ via prepublishOnly)
bun run release:publish --dry-run
bun run release:publish

# 3. Push tags
git push --follow-tags
```
