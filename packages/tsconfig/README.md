# @urbicon/tsconfig

Shared TypeScript base configuration for Bun/Svelte projects.

## Installation

```bash
bun add -D @urbicon/tsconfig
```

(Requires a `bunfig.toml` mapping the `@urbicon` scope to the public registry `https://codeberg.org/api/packages/urbicon/npm/` — `udx init` creates it; no token needed.)

## Usage

**Plain Bun/TypeScript project:**

```jsonc
// tsconfig.json
{
  "extends": "@urbicon/tsconfig/base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src"]
}
```

**SvelteKit project** — additionally include the generated SvelteKit config last,
so its `rootDirs`/`$lib` paths win:

```jsonc
// tsconfig.json
{
  "extends": ["@urbicon/tsconfig/svelte.json", "./.svelte-kit/tsconfig.json"],
  "compilerOptions": {
    "baseUrl": "."
  }
}
```

## Variants

| File          | Purpose                                                          |
| ------------- | --------------------------------------------------------------- |
| `base.json`   | Strict defaults, library emit (declaration/sourceMap) on        |
| `svelte.json` | Inherits from `base.json`, emit off, `DOM.Iterable`, for SvelteKit |

Updates come in via `bun update @urbicon/tsconfig`.
