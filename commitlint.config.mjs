import { createConfig } from '@urbicon/commitlint-config';

// Scopes für dieses Repo (das udx-Harness selbst).
export default createConfig({
  scopes: ['cli', 'biome-config', 'commitlint-config', 'tsconfig', 'claude', 'deps']
});
