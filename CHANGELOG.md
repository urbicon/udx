# Changelog

All notable changes to this project will be documented in this file.
This changelog is automatically generated from [Conventional Commits](https://www.conventionalcommits.org).


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
