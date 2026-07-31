# Changelog

All notable changes to this project will be documented in this file.
This changelog is automatically generated from [Conventional Commits](https://www.conventionalcommits.org).


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
