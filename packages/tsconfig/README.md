# @urbicon-ui/tsconfig

Shared TypeScript base configuration for Bun/Svelte projects.

## Installation

```bash
bun add -D @urbicon-ui/tsconfig
```

## Usage

**Plain Bun/TypeScript project:**

```jsonc
// tsconfig.json
{
  "extends": "@urbicon-ui/tsconfig/base.json",
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
  "extends": ["@urbicon-ui/tsconfig/svelte.json", "./.svelte-kit/tsconfig.json"],
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

Updates come in via `bun update @urbicon-ui/tsconfig`.
