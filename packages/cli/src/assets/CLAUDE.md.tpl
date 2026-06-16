# {{projectName}}

## Development harness

This project uses the shared **@urbicon/udx** harness. Update with `udx sync`.

### Tools

| Area          | Tool                                              |
| ------------- | ------------------------------------------------- |
| Format/Lint   | Biome (`@urbicon/biome-config`)                   |
| Svelte format | Prettier + `prettier-plugin-svelte` (`.svelte` only) |
| Commits       | Conventional Commits (`@urbicon/commitlint-config`) |
| Changelog     | git-cliff (`cliff.toml`)                           |
| Git hooks     | Lefthook (`lefthook.yml`)                          |
| Versioning    | `scripts/bump.sh` → `bun run bump[:minor|:major]`  |
| TS config     | `@urbicon/tsconfig`                                |
| Dep updates   | Renovate (`renovate.json`)                         |

### Commands

```bash
bun run format    # format code
bun run lint      # lint + (with Svelte) svelte-check
bun run fix       # auto-fix lint errors
bun run bump      # patch release: version + changelog + tag
bun run changelog # regenerate the changelog
```

### Commits

[Conventional Commits](https://www.conventionalcommits.org): `<type>(<scope>): <desc>`.
Types: `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `chore`, `build`, `ci`, `perf`.
Commits drive the changelog (git-cliff) — use correct types/scopes.

### Versioning

After a coherent set of changes: `bun run bump` (patch), `bun run bump:minor`
(new feature, `feat`), or `bun run bump:major` (breaking change). Produces a
release commit + annotated tag. Push with `git push --follow-tags`.
