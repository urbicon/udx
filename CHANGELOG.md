# Changelog

All notable changes to this project will be documented in this file.
This changelog is automatically generated from [Conventional Commits](https://www.conventionalcommits.org).


## [0.4.2] - 2026-10-09

### Bug Fixes
- **commitlint-config**: Let a subject open with a capitalized noun
- **cli**: Write generated JSON in Biome's format
- **cli**: Adopt a config's preset dep in the same sync run
- **cli**: Keep prepare from failing installs without .git

## [0.4.1] - 2026-10-09

### Bug Fixes
- **cli**: Keep ** out of the biome.json template's files.includes
- **cli**: Doctor only flags a biome $schema older than the pin

### CI/CD
- Publish from GitHub Actions via npm trusted publishing

### Features
- **cli**: Support SvelteKit 3 in the tsconfig template and prepare

## [0.4.0] - 2026-09-27

### Documentation
- Describe the opt-in knowledge layer and when a skill belongs in udx

### Features
- **cli**: Opt-in knowledge capability — a skill, the docs:check gate and templates

## [0.3.1] - 2026-07-31

### Bug Fixes
- **cli**: Match both TOML spellings when pruning the legacy registry

## [0.3.0] - 2026-07-31

### Breaking Changes
- Move to GitHub, publish to npm under @urbicon-ui
> **BREAKING:** the packages are published as @urbicon-ui/* on npm; the @urbicon scope on Codeberg receives no further releases. A project whose create-only config (biome.json, tsconfig.json, commitlint.config.mjs) still references the old package counts as self-managed, so its dep is deliberately left alone until `udx sync --only <id> --force` rewrites that config.

### Build
- Convenience-scripts

## [0.2.9] - 2026-06-17

### Features
- **cli**: Detect prettier/biome indent conflict, manage .prettierignore

## [0.2.8] - 2026-06-16

### Miscellaneous
- Remove bundled Claude plugin (unrelated to the harness)

## [0.2.7] - 2026-06-16

### Miscellaneous
- Initial commit
