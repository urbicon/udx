# {{projectName}}

## Entwicklungs-Harness

Dieses Projekt nutzt das geteilte **@urbicon/udx**-Harness. Aktualisieren mit `udx sync`.

### Werkzeuge

| Bereich       | Werkzeug                                          |
| ------------- | ------------------------------------------------- |
| Format/Lint   | Biome (`@urbicon/biome-config`)                   |
| Svelte-Format | Prettier + `prettier-plugin-svelte` (nur `.svelte`) |
| Commits       | Conventional Commits (`@urbicon/commitlint-config`) |
| Changelog     | git-cliff (`cliff.toml`)                           |
| Git-Hooks     | Lefthook (`lefthook.yml`)                          |
| Versionierung | `scripts/bump.sh` → `bun run bump[:minor|:major]`  |
| TS-Config     | `@urbicon/tsconfig`                                |

### Commands

```bash
bun run format    # Code formatieren
bun run lint      # Lint + (bei Svelte) svelte-check
bun run fix       # Lint-Fehler automatisch beheben
bun run bump      # Patch-Release: Version + Changelog + Tag
bun run changelog # Changelog neu generieren
```

### Commits

[Conventional Commits](https://www.conventionalcommits.org): `<type>(<scope>): <desc>`.
Typen: `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `chore`, `build`, `ci`, `perf`.
Commits steuern den Changelog (git-cliff) — korrekte Typen/Scopes verwenden.

### Versionierung

Nach einem zusammenhängenden Satz Änderungen: `bun run bump` (patch), `bun run bump:minor`
(neues Feature, `feat`) oder `bun run bump:major` (Breaking Change). Erzeugt einen
Release-Commit + annotierten Tag. Push mit `git push --follow-tags`.
