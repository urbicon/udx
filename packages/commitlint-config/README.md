# @urbicon/commitlint-config

Shared [commitlint](https://commitlint.js.org) configuration based on
Conventional Commits, with a factory for project-specific scopes.

## Installation

```bash
bun add -D @commitlint/cli @urbicon/commitlint-config
```

(`@commitlint/config-conventional` comes along as a dependency.)

## Usage

```js
// commitlint.config.mjs
import { createConfig } from '@urbicon/commitlint-config';

export default createConfig({
  scopes: ['ui', 'api', 'core', 'deps']
});
```

Without scopes (just the Conventional Commits base):

```js
import config from '@urbicon/commitlint-config';
export default config;
```

Scopes are checked as a **warning** (level 1) — an unknown scope does not block
the commit, but shows up as a hint. Additional rules via `rules`.
