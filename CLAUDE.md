# @urbicon/udx — Entwicklungs-Harness

## Projekt-Überblick

Geteiltes Dev-Harness für Bun/Svelte-Projekte: Configs, eine `udx`-CLI und ein
Claude-Plugin. Ziel: bewährtes Setup (Biome, Conventional Commits, git-cliff,
Lefthook, bump-Pipeline) **einmal pflegen** und in Projekte verteilen statt
kopieren — inklusive `udx sync`, um Verbesserungen nachzuziehen.

## Architektur

Bun-Workspace-Monorepo, das **seine eigenen Configs dogfooded** (Root-`biome.json`
extendet `@urbicon/biome-config` usw.).

| Paket / Ordner               | Rolle                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| `packages/tsconfig`          | `@urbicon/tsconfig` — `base.json`, `svelte.json`            |
| `packages/biome-config`      | `@urbicon/biome-config` — geteilte `biome.json`             |
| `packages/commitlint-config` | `@urbicon/commitlint-config` — `createConfig({ scopes })`   |
| `packages/cli`               | `@urbicon/udx` — `init` / `sync` / `doctor`                  |
| `claude/`                    | Claude-Plugin (Skills, z. B. `docs-review`)                 |

### Zwei Baustein-Arten (Kernkonzept)

1. **Erweiterbar** → Config-Pakete; Inhalt lebt im Paket, Update via Versionsbump.
2. **Müssen physisch existieren** (`cliff.toml`, `lefthook.yml`, `scripts/bump.sh`,
   `.npmrc`) → von der CLI geschrieben. Datei-Policies in
   `packages/cli/src/templates/index.ts`:
   - **managed** → `udx sync` überschreibt bei Drift (Verbesserungen fließen zurück)
   - **create-only** → nur angelegt, wenn fehlend (Projekt-Anpassungen bleiben)

### CLI-Aufbau (`packages/cli/src`)

- `bin/udx.ts` — Arg-Parsing + Dispatch (zero runtime deps)
- `commands/harness.ts` — geteilte `init`/`sync`-Logik
- `commands/doctor.ts` — read-only Drift-Check
- `lib/` — `detect` (Svelte-Erkennung), `apply` (Datei-Engine + `.npmrc`),
  `pkg` (package.json-Patch), `versions` (gepinnte Versionen), `fs`/`log`/`colors`
- `templates/` — Render-Funktionen; komplexe Dateien (`cliff.toml`, `bump.sh`,
  `CLAUDE.md.tpl`) als Text-Assets unter `src/assets/` (Import via
  `with { type: 'text' }`, damit `${...}` in bump.sh nicht mit JS kollidiert)

## Commands

```bash
bun install
bun --filter='@urbicon/udx' run build   # CLI bauen (bun build → dist/bin/udx.js)
bun --filter='@urbicon/udx' run test    # bun test
bun --filter='@urbicon/udx' run check   # tsc --noEmit
bun run lint                           # Biome (Root)
bun run fix                            # Biome --write
```

CLI lokal ausführen ohne Build: `bun run packages/cli/src/bin/udx.ts <befehl>`.

## Konventionen

- **Stack-Entscheidungen**: Biome (TS/JS/JSON), Prettier nur für `.svelte` (Hybrid),
  Lefthook, Conventional Commits + git-cliff. Beim Ändern von Templates **beide
  Seiten** denken: das Asset/Render **und** ob `init`/`sync`/`doctor` korrekt damit
  umgehen.
- **Versionen** gepinnt in `packages/cli/src/lib/versions.ts` — hier zentral
  aktualisieren, nicht verstreut.
- **Dogfooding**: Root-Configs nutzen die eigenen Pakete. Nach Änderungen an einem
  Config-Paket prüfen, dass das Root-Setup weiter lädt.

## Commits & Releases

Conventional Commits, Scopes: `cli`, `biome-config`, `commitlint-config`,
`tsconfig`, `claude`, `deps`. Release: `bun run bump[:minor|:major]` → Version +
Changelog (git-cliff) + annotated Tag. Push mit `git push --follow-tags`.

## Distribution

`@urbicon/*` → Codebergs npm-Registry (`.npmrc`, Auth via `CODEBERG_TOKEN`).
Claude-Plugin → Marketplace `.claude-plugin/marketplace.json` (Repo-Root).
