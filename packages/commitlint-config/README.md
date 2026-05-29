# @urbicon/commitlint-config

Geteilte [commitlint](https://commitlint.js.org)-Konfiguration auf Basis von
Conventional Commits, mit einer Factory für projektspezifische Scopes.

## Installation

```bash
bun add -D @commitlint/cli @urbicon/commitlint-config
```

(`@commitlint/config-conventional` kommt als Abhängigkeit mit.)

## Verwendung

```js
// commitlint.config.mjs
import { createConfig } from '@urbicon/commitlint-config';

export default createConfig({
  scopes: ['ui', 'api', 'core', 'deps']
});
```

Ohne Scopes (nur Conventional-Commits-Basis):

```js
import config from '@urbicon/commitlint-config';
export default config;
```

Scopes werden als **Warnung** (Level 1) geprüft — ein unbekannter Scope blockiert
den Commit nicht, taucht aber als Hinweis auf. Zusätzliche Regeln via `rules`.
