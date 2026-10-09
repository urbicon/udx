# @urbicon-ui/commitlint-config

Shared [commitlint](https://commitlint.js.org) configuration based on
Conventional Commits, with a factory for project-specific scopes.

## Installation

```bash
bun add -D @commitlint/cli @urbicon-ui/commitlint-config
```

(`@commitlint/config-conventional` comes along as a dependency.)

## Usage

```js
// commitlint.config.mjs
import { createConfig } from '@urbicon-ui/commitlint-config';

export default createConfig({
  scopes: ['ui', 'api', 'core', 'deps']
});
```

Without scopes (just the Conventional Commits base):

```js
import config from '@urbicon-ui/commitlint-config';
export default config;
```

Scopes are checked as a **warning** (level 1) — an unknown scope does not block
the commit, but shows up as a hint. Additional rules via `rules`.

Unlike `config-conventional`, the subject's case is not checked (`subject-case`
is off): a German subject may open with a noun, which is capitalized
(`feat: Suche über alle Rezepte`). To restore the upstream check:

```js
createConfig({
  rules: {
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']]
  }
});
```
