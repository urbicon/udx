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
   `.npmrc`) → schreibt/aktualisiert die `udx`-CLI. `udx sync` zieht Änderungen nach.

## Schnellstart in einem Projekt

```bash
# 1. Registry bekanntmachen (einmalig pro Projekt, macht udx init auch selbst)
echo '@urbicon:registry=https://codeberg.org/api/packages/urbicon/npm/' >> .npmrc

# 2. Harness einrichten
bunx @urbicon/udx init        # oder: udx init (global installiert)
bun install
bunx lefthook install

# 3. Später Verbesserungen nachziehen
udx sync --dry-run            # Vorschau
udx sync                      # übernehmen
udx doctor                    # Drift prüfen
```

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

Veröffentlichen in Codebergs npm-Registry: `CODEBERG_TOKEN` setzen, dann je Paket
`bun publish` (bzw. via Release-Pipeline). Siehe `.npmrc`.
