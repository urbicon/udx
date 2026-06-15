# Changelog

All notable changes to this project will be documented in this file.
This changelog is automatically generated from [Conventional Commits](https://www.conventionalcommits.org).


## [0.2.2] - 2026-06-15

### Bug Fixes
- **cli**: Bump.sh nutzt bun run test statt bun test bei der Verifikation

### Build
- Upgrade dependencies

## [0.2.1] - 2026-06-10

### Bug Fixes
- **cli**: Wirkungsloses .prettierignore-Template korrigieren

## [0.2.0] - 2026-06-10

### Features
- **tsconfig**: Typen via @types/bun statt bun-types beziehen
- **cli**: Renovate-Baustein, core.hooksPath-Erkennung & @types/bun-Migration

## [0.1.5] - 2026-06-09

### Bug Fixes
- **cli**: Pins als baseline behandeln statt downgrades zu erzwingen
- **cli**: SatisfiesPin robuster gegen compound-ranges & alias-specifier
- **cli**: Gepinnte fehlende dep melden statt still schlucken
- **cli**: Status — declined-dateien strukturell filtern, manifest teilen
- **deps**: Stack:update review-befunde + renovate via customManager
- **cli**: InstallDeps — spawn-throw abfangen, ehrlichere fehlermeldung
- **cli**: Generierte biome.json schließt .svelte immer aus
- **cli**: Add ist additiv — kein force-overwrite von create-only (WP9-review)

### Documentation
- **plan**: Version-governance roadmap mit abhakbaren arbeitspaketen
- Wp1+wp2 im plan abgehakt, npm-only-entscheidung festgehalten
- Wp3+wp5 im plan abgehakt
- Wp4 im plan abgehakt
- Wp6 im plan abgehakt
- Wp7 im plan abgehakt
- Wp8 im plan abgehakt — wp1–wp8 vollständig
- Wp9 + biome-svelte-fix im plan abgehakt (buny-feedback)
- D9-Plan ins Repo + Defer-Item in version-governance abgehakt

### Features
- **cli**: Sync zieht versionen sicher hoch (ohne --force) + udx pin/unpin
- **cli**: Udx status — gruppierte sicht auf zustand, drift & aktion
- **cli**: Udx add/remove — dev-facing verben + naming-aliase
- **deps**: Stack:update-script + renovate für catalog-bumps
- **cli**: Udx sync/init/add --install — bun install opt-in
- **cli**: Verdrahtungs-bewusstsein für @urbicon-config-pakete (WP9)
- **cli**: Per-Paket-Svelte-Tier — schließt den Svelte-Monorepo-Gap (D9 WP1)
- **cli**: Catalog-Read-Modell + Plan-Arrays für den Catalog-Modus (D9 WP2)
- **cli**: Atomare Catalog-Writes + Root-pkg-Verdrahtung (D9 WP3)
- **cli**: Status/doctor Catalog-Reporting + geteilter Workspace-Helfer (D9 WP4)

### Refactoring
- **cli**: Versions.ts aus dem bun-catalog ableiten statt hardcodieren

### Testing
- **cli**: Dogfooding-invariante — udx nutzt seinen catalog konsequent
- Svelte-fixture dogfoodet den vorgeschriebenen svelte-toolstack
- Prettier in svelte-fixture auf .svelte scopen (.prettierignore)

## [0.1.4] - 2026-06-08

### Miscellaneous
- Dependency updates

## [0.1.3] - 2026-06-08

### Miscellaneous
- Dependency updates

## [0.1.2] - 2026-06-08

### Bug Fixes
- **cli**: Tighten cross-feature interactions from integrative review

### Documentation
- **cli**: Document 3-way sync, capabilities, --only/--diff/--interactive, monorepo

### Features
- **cli**: Add .udx.json manifest with 3-way drift detection
- **cli**: Add capabilities with auto-decline for foreign stacks
- **cli**: Add --diff to show local-vs-template changes on drift
- **cli**: Add --only and --interactive for selective sync/migration
- **cli**: Add monorepo workspace support (per-package tsconfig)
- **cli**: Normalize internal dep ranges and stage lockfile in bump.sh

## [0.1.1] - 2026-05-30

### Bug Fixes
- **commitlint-config**: Declare @commitlint/types and enforce real typecheck
- **cli**: Derive @urbicon version pins from own package version
- **cli**: Correct init next-steps footer

### Build
- **cli**: Minify bundle, add sourcemap and prepublishOnly hook

### Documentation
- Bunfig.toml migration, Codeberg publish workflow, placeholder path
- Add harness review todo with status and remaining actions

### Features
- Scaffold shared dev-harness (configs, udx CLI, claude plugin)
- **biome-config**: Protect generated CHANGELOG.md from Biome
- **cli**: Use bunfig.toml for registry config instead of .npmrc
- **cli**: Add publish auth and orchestration for Codeberg registry

### Miscellaneous
- Commit bun.lock for reproducible installs

### Refactoring
- **cli**: Drop dead context fields, dedupe detection, single-source Biome schema
- **cli**: Make bump.sh bun-native (drop node/npm dependency)

### Testing
- **cli**: Cover mutatePkg, ensureBunfig, force mode and version pinning
