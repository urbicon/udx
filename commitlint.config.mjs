import { createConfig } from '@urbicon-ui/commitlint-config';

// Scopes for this repo (the udx harness itself).
export default createConfig({
  scopes: ['cli', 'biome-config', 'commitlint-config', 'tsconfig', 'deps']
});
