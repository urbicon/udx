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
   `bunfig.toml`) → von der CLI geschrieben. Datei-Policies in
   `packages/cli/src/templates/index.ts`:
   - **managed** → 3-Wege-Sync via `.udx.json`-Hashes: unberührt-veraltete Dateien zieht
     `udx sync` nach, lokal geänderte schützt es als Konflikt (`--force` überschreibt)
   - **create-only** → nur angelegt, wenn fehlend (Projekt-Anpassungen bleiben)
   - **scope** `root` (Default) vs `package`: im Monorepo laufen `package`-Bausteine
     (z. B. `tsconfig`) je Workspace-Paket (Svelte je Paket erkannt), nicht im Root.
     Reine Asset-Pakete ohne TS-Code werden übersprungen (`isTypeScriptPackage`).
     `package`-Bausteine müssen `create-only` sein (sonst kollidieren Manifest-Hashes)

### Capabilities (Stack-Awareness)

`lib/capabilities.ts` bündelt stack-spezifische Bausteine (Datei + Scripts + devDeps) zu
declinebaren Einheiten (`git-hooks`→lefthook, `lint-format`→biome). `supersededBy(ctx)`
erkennt **generisch** (über deps/Dateien, nie über Projektnamen) einen konkurrierenden
Stack (husky, eslint, …); der Baustein wird dann automatisch abgewählt und die Entscheidung
in `.udx.json` `declined` persistiert. `udx adopt <id>` / `udx skip <id>` steuern das manuell.
Abgewählte Bausteine sind in `init`/`sync`/`doctor` kein Soll (kein Fehler).

### CLI-Aufbau (`packages/cli/src`)

- `bin/udx.ts` — Arg-Parsing + Dispatch (zero runtime deps)
- `commands/harness.ts` — geteilte `init`/`sync`-Logik
- `commands/doctor.ts` — read-only Drift-Check
- `commands/capability.ts` — `adopt`/`skip` (Bausteine auf-/abwählen)
- `lib/` — `detect` (Svelte-Erkennung), `apply` (Datei-Engine + `bunfig.toml`),
  `manifest` (`.udx.json`: 3-Wege-Hashes + abgewählte/aufgenommene Bausteine),
  `capabilities` (declinebare Stack-Bündel + Konflikterkennung + `--only`-Auflösung),
  `diff` (zero-dep LCS-Diff für `--diff`), `workspace` (Monorepo-Pakete via `Bun.Glob`),
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

`@urbicon/*` → Codebergs npm-Registry (privat ⇒ Token auch zum Installieren nötig).
Auth-Aufteilung: `bun install` nutzt `bunfig.toml` `[install.scopes]` (token),
`bun publish` nutzt `.npmrc` (`:_authToken=$CODEBERG_TOKEN`) — bunfig gilt dort nicht;
Bun interpoliert `$VAR`, nicht `${VAR}`. Beide referenzieren nur `$CODEBERG_TOKEN`
(Env/.env), kein Secret. Release: `bun run bump` → `bun run release:publish`
(Config-Pakete vor der CLI). `versions.ts` zieht die `@urbicon/*`-Pins automatisch
aus der eigenen Version nach.
Claude-Plugin → Marketplace `.claude-plugin/marketplace.json` (Repo-Root).
