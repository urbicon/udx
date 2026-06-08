# @urbicon/udx

CLI zum Einrichten und **Synchronisieren** des urbicon-Entwicklungs-Harness in
Bun/Svelte-Projekten. Schreibt die nicht-erweiterbaren Dateien (cliff.toml,
Lefthook-Hooks, bump.sh, bunfig.toml) und verdrahtet die erweiterbaren Config-Pakete
(`@urbicon/biome-config`, `@urbicon/commitlint-config`, `@urbicon/tsconfig`).

## Installation

```bash
# Voraussetzung: @urbicon-Scope global bekannt (~/.bunfig.toml) + CODEBERG_TOKEN gesetzt
bun add -g @urbicon/udx
```

Lokale Entwicklung aus diesem Repo:

```bash
cd packages/cli && bun link        # global verfügbar machen
# oder direkt:  bun run packages/cli/src/bin/udx.ts <befehl>
```

## Befehle

| Befehl          | Zweck                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| `udx init`      | Harness in ein Projekt einrichten (Auto-Erkennung Svelte vs. reines TS)  |
| `udx sync`      | Verwaltete Dateien aktualisieren — **Prozessverbesserungen nachziehen**  |
| `udx doctor`    | Read-only: fehlende/abweichende Teile prüfen (Exit-Code 1 bei Problemen) |
| `udx adopt <id>`| Abgewählten Baustein wieder aufnehmen (überstimmt die Auto-Abwahl)        |
| `udx skip <id>` | Baustein dauerhaft abwählen (eigener Stack — z. B. husky statt lefthook)  |

### Optionen

| Flag                | Wirkung                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `-n, --dry-run`     | nichts schreiben, nur Vorschau                                           |
| `-f, --force`       | auch lokal geänderte `managed`-Dateien & package.json-Drift überschreiben |
| `-i, --interactive` | bei Konflikten pro Datei entscheiden (update/skip/diff)                  |
| `--only <ids>`      | nur diese Bausteine (Capability- oder Datei-Ids, kommasepariert)         |
| `--diff`            | bei Drift den Unterschied lokal → Template anzeigen                      |
| `--svelte` / `--no-svelte` | Svelte-Setup erzwingen / reines TS-Setup erzwingen               |
| `--cwd <pfad>`      | Zielverzeichnis (Default: aktuelles)                                     |

## Datei-Policies

- **managed** (`cliff.toml`, `lefthook.yml`, `scripts/bump.sh`): **3-Wege-Sync** über
  die in `.udx.json` gemerkten Hashes. Unberührt-veraltete Dateien zieht `udx sync`
  nach (Verbesserungen fließen zurück); **lokal geänderte** schützt es als Konflikt
  (`--force` übernimmt, `--diff` zeigt den Unterschied, `--interactive` fragt).
- **create-only** (`biome.json`, `tsconfig.json`, `commitlint.config.mjs`,
  `.prettierrc`*, `.gitignore`, `CLAUDE.md`): nur angelegt, wenn sie fehlen —
  Projekt-Anpassungen bleiben erhalten. Inhaltliche Updates kommen über die
  Config-Pakete (Versionsbump).

(* nur Svelte-Projekte.)

`bunfig.toml` wird **additiv** behandelt: fehlt der `@urbicon`-Scope, wird er
ergänzt (bzw. die Datei angelegt); ein bereits vorhandener `[install.scopes]`-Block
wird nicht angetastet, sondern die zu ergänzende Zeile gemeldet.

`package.json` wird idempotent gepatcht: fehlende Scripts/devDeps werden ergänzt;
abweichende Werte bleiben stehen und werden gemeldet (`--force` überschreibt).

## Stack-Awareness (Capabilities)

Stack-spezifische Bausteine sind zu **Capabilities** gebündelt und werden automatisch
abgewählt, wenn udx einen konkurrierenden Stack erkennt — ohne Projekt-Hardcoding:

| Capability    | Bausteine              | wird abgewählt bei            |
| ------------- | ---------------------- | ----------------------------- |
| `git-hooks`   | lefthook + prepare     | husky / `.husky/` / simple-git-hooks |
| `lint-format` | biome + lint/format/fix | eslint                       |

Abgewählte Bausteine sind kein Soll (kein `doctor`-Fehler); die Entscheidung wird in
`.udx.json` persistiert. Migration: `udx adopt git-hooks && udx sync --only git-hooks`.

## Monorepo

Im Workspace-Monorepo (Array- oder Objekt-Form, inkl. Bun-Catalogs) laufen Root-Bausteine
einmal im Root; `tsconfig` wird je TS-Paket angelegt (Svelte je Paket erkannt, reine
Asset-Pakete übersprungen). Die projektspezifische Root-`tsconfig` bleibt unberührt.

## Manifest (`.udx.json`)

udx schreibt ein versioniertes, ins git gehörendes Manifest mit: zuletzt geschriebenen
Datei-Hashes (3-Wege-Drift), abgewählten (`declined`) und aufgenommenen (`adopted`)
Capabilities. Von Hand editierbar; korrupte Einträge werden tolerant ignoriert.
