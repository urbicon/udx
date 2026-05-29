/** Gepinnte Versionen, die `udx init`/`udx sync` in Consumer-Projekte schreiben. */
export const VERSIONS = {
  '@biomejs/biome': '^2.4.16',
  '@commitlint/cli': '^21.0.1',
  lefthook: '^1.8.0',
  'git-cliff': '^2.13.1',
  '@types/node': '^25.9.1',
  'bun-types': '^1.3.14',
  typescript: '^6.0.3',
  '@urbicon/biome-config': '^0.1.0',
  '@urbicon/commitlint-config': '^0.1.0',
  '@urbicon/tsconfig': '^0.1.0',
  // nur Svelte-Projekte
  prettier: '^3.8.3',
  'prettier-plugin-svelte': '^4.0.1',
  'prettier-plugin-tailwindcss': '^0.8.0',
  'svelte-check': '^4.3.1'
} as const;

export type DepName = keyof typeof VERSIONS;
