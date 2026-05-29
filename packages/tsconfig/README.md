# @urbicon/tsconfig

Geteilte TypeScript-Basiskonfiguration für Bun/Svelte-Projekte.

## Installation

```bash
bun add -D @urbicon/tsconfig
```

(Setzt eine `bunfig.toml` mit dem `@urbicon`-Scope auf `https://codeberg.org/api/packages/urbicon/npm/` voraus — legt `udx init` an.)

## Verwendung

**Reines Bun/TypeScript-Projekt:**

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

**SvelteKit-Projekt** — zusätzlich die generierte SvelteKit-Config zuletzt einbinden,
damit deren `rootDirs`/`$lib`-Pfade gewinnen:

```jsonc
// tsconfig.json
{
  "extends": ["@urbicon/tsconfig/svelte.json", "./.svelte-kit/tsconfig.json"],
  "compilerOptions": {
    "baseUrl": "."
  }
}
```

## Varianten

| Datei         | Zweck                                                            |
| ------------- | --------------------------------------------------------------- |
| `base.json`   | Strenge Defaults, Library-Emit (declaration/sourceMap) an       |
| `svelte.json` | Erbt von `base.json`, Emit aus, `DOM.Iterable`, für SvelteKit   |

Updates fließen über `bun update @urbicon/tsconfig`.
