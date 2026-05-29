# @urbicon/biome-config

Geteilte [Biome](https://biomejs.dev)-Basiskonfiguration (Formatter + Linter).

Spiegelt die bisherigen Prettier-Präferenzen: 2 Spaces, Single Quotes, keine
Trailing Commas, Zeilenbreite 100 — plus Biomes empfohlene Lint-Regeln und
Import-Sortierung.

## Installation

```bash
bun add -D @biomejs/biome @urbicon/biome-config
```

## Verwendung

```jsonc
// biome.json
{
  "$schema": "https://biomejs.dev/schemas/2.4.16/schema.json",
  "extends": ["@urbicon/biome-config/biome-base.json"]
}
```

## Svelte (Hybrid-Strategie)

Biome formatiert/lintet `.svelte` noch nicht vollständig. In SvelteKit-Projekten
übernimmt deshalb **Prettier (`prettier-plugin-svelte`) nur die `.svelte`-Dateien**,
Biome den Rest. Die `.svelte`-Dateien aus Biome ausschließen:

```jsonc
// biome.json
{
  "extends": ["@urbicon/biome-config/biome-base.json"],
  "files": {
    "includes": ["**", "!**/*.svelte"]
  }
}
```

`udx init` richtet das für Svelte-Projekte automatisch ein.
