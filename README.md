# @urbicon/udx

Geteiltes **Entwicklungs-Harness** für Bun- und Svelte/SvelteKit-Projekte. Ein Ort
für Configs, Tooling und Claude-Skills, die bisher von Hand zwischen Projekten
kopiert wurden — inklusive Mechanismus, um Verbesserungen wieder **zurückzuspielen**.

## Was drin ist

| Paket / Ordner               | Rolle                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `@urbicon/tsconfig`          | TypeScript-Basiskonfig (`base.json` + `svelte.json`)                 |
| `@urbicon/biome-config`      | Biome Formatter + Linter (ersetzt Prettier + ESLint für TS/JS/JSON)  |
| `@urbicon/commitlint-config` | Conventional Commits mit Scope-Factory                               |
| `@urbicon/udx` (CLI)          | `udx init` / `udx sync` / `udx doctor` — verteilt & aktualisiert alles  |
| `claude/`                    | Claude-Code-Plugin (Skills wie `docs-review`)                        |

## Zwei Arten von Bausteinen

1. **Erweiterbar** (Biome, commitlint, tsconfig) → als Pakete; Update via
   `bun update`. Inhalt lebt zentral im Paket.
2. **Müssen physisch existieren** (`cliff.toml`, `lefthook.yml`, `scripts/bump.sh`,
   `bunfig.toml`) → schreibt/aktualisiert die `udx`-CLI. `udx sync` zieht Änderungen nach.

## Schnellstart in einem Projekt

```bash
# Voraussetzung: Zugriff auf die (private) @urbicon-Registry
export CODEBERG_TOKEN=<dein-codeberg-token>   # z. B. in einer gitignorten .env

# 1. Harness einrichten — legt bunfig.toml mit der @urbicon-Registry selbst an
bunx @urbicon/udx init        # oder: udx init (global installiert)
bun install                   # Deps + Git-Hooks (via prepare-Script)

# 2. Später Verbesserungen nachziehen
udx sync --dry-run            # Vorschau
udx sync                      # übernehmen (--force aktualisiert auch devDep-Pins)
udx doctor                    # Drift prüfen
```

> Solange `@urbicon/udx` noch nicht publiziert ist, greift `bunx @urbicon/udx` nicht —
> siehe [Erst-Bootstrap](#veröffentlichen-codeberg-registry).

## Stack-Entscheidungen

- **Biome statt Prettier+ESLint** für TS/JS/JSON/JSONC.
- **Svelte hybrid**: `.svelte` macht Prettier (`prettier-plugin-svelte`), Biome
  ignoriert `.svelte`; Svelte-Typen via `svelte-check`.
- **Lefthook** als Git-Hook-Manager (eine `lefthook.yml` statt `.husky/`).
- **Conventional Commits → git-cliff → Changelog**, Releases via `scripts/bump.sh`.

## Entwicklung an diesem Repo

```bash
bun install
bun --filter='@urbicon/udx' run build   # CLI bauen
bun --filter='@urbicon/udx' run test    # CLI testen
bun run lint                           # Biome
```

## Veröffentlichen (Codeberg-Registry)

Die `@urbicon/*`-Pakete liegen in Codebergs (privater) npm-Registry; `CODEBERG_TOKEN`
muss gesetzt sein (Scope-Config in `bunfig.toml`, Token via Env/`.env`).

```bash
# 1. Release vorbereiten (Version + Changelog + Tag, unified über alle Pakete)
bun run bump            # oder bump:minor / bump:major

# 2. Pro Paket publizieren — Config-Pakete zuerst, dann die CLI
( cd packages/tsconfig         && bun publish )
( cd packages/biome-config     && bun publish )
( cd packages/commitlint-config && bun publish )
( cd packages/cli              && bun publish )   # prepublishOnly baut dist/ frisch

# 3. Tags pushen
git push --follow-tags
```

**Erst-Bootstrap:** `@urbicon/udx` lässt sich nicht via `bunx @urbicon/udx` beziehen,
solange es nicht publiziert ist. Bis dahin aus einem Klon heraus arbeiten —
`bun run packages/cli/src/bin/udx.ts <befehl>` oder `cd packages/cli && bun link`.
