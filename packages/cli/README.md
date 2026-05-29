# @urbicon/udx

CLI zum Einrichten und **Synchronisieren** des urbicon-Entwicklungs-Harness in
Bun/Svelte-Projekten. Schreibt die nicht-erweiterbaren Dateien (cliff.toml,
Lefthook-Hooks, bump.sh, .npmrc) und verdrahtet die erweiterbaren Config-Pakete
(`@urbicon/biome-config`, `@urbicon/commitlint-config`, `@urbicon/tsconfig`).

## Installation

```bash
# .npmrc mit @urbicon-Registry vorausgesetzt
bun add -g @urbicon/udx
```

Lokale Entwicklung aus diesem Repo:

```bash
cd packages/cli && bun link        # global verfügbar machen
# oder direkt:  bun run packages/cli/src/bin/udx.ts <befehl>
```

## Befehle

| Befehl      | Zweck                                                                      |
| ----------- | -------------------------------------------------------------------------- |
| `udx init`   | Harness in ein Projekt einrichten (Auto-Erkennung Svelte vs. reines TS)    |
| `udx sync`   | Verwaltete Dateien aktualisieren — **Prozessverbesserungen nachziehen**    |
| `udx doctor` | Read-only: fehlende/abweichende Teile prüfen (Exit-Code 1 bei Problemen)   |

### Optionen

| Flag             | Wirkung                                                              |
| ---------------- | ------------------------------------------------------------------- |
| `-n, --dry-run`  | nichts schreiben, nur Vorschau                                      |
| `-f, --force`    | auch abweichende `managed`-Dateien & package.json-Drift überschreiben |
| `--svelte`       | Svelte-Setup erzwingen                                              |
| `--no-svelte`    | reines TS-Setup erzwingen                                           |
| `--cwd <pfad>`   | Zielverzeichnis (Default: aktuelles)                               |

## Datei-Policies

- **managed** (`cliff.toml`, `lefthook.yml`, `scripts/bump.sh`): von `udx sync` bei
  Drift überschrieben — hier fließen Verbesserungen in alle Projekte zurück.
- **create-only** (`biome.json`, `tsconfig.json`, `commitlint.config.mjs`,
  `.prettierrc`*, `.gitignore`, `CLAUDE.md`): nur angelegt, wenn sie fehlen —
  Projekt-Anpassungen bleiben erhalten. Inhaltliche Updates kommen über die
  Config-Pakete (Versionsbump).

(* nur Svelte-Projekte.)

`package.json` wird idempotent gepatcht: fehlende Scripts/devDeps werden ergänzt;
abweichende Werte bleiben stehen und werden gemeldet (`--force` überschreibt).
