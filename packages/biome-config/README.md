# @urbicon-ui/biome-config

Shared [Biome](https://biomejs.dev) base configuration (formatter + linter).

Mirrors the previous Prettier preferences: 2 spaces, single quotes, no
trailing commas, line width 100 — plus Biome's recommended lint rules and
import sorting.

## Installation

```bash
bun add -D @biomejs/biome @urbicon-ui/biome-config
```

## Usage

```jsonc
// biome.json
{
  "$schema": "https://biomejs.dev/schemas/2.4.16/schema.json",
  "extends": ["@urbicon-ui/biome-config/biome-base.json"]
}
```

## Svelte (hybrid strategy)

Biome does not yet fully format/lint `.svelte` files. In SvelteKit projects,
**Prettier (`prettier-plugin-svelte`) therefore handles only the `.svelte` files**,
while Biome handles the rest. Exclude the `.svelte` files from Biome:

```jsonc
// biome.json
{
  "extends": ["@urbicon-ui/biome-config/biome-base.json"],
  "files": {
    "includes": ["**", "!**/*.svelte"]
  }
}
```

`udx init` sets this up automatically for Svelte projects.
