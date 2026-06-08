import cliPkg from '../../package.json' with { type: 'json' };

/**
 * Die @urbicon-Config-Pakete sind unified versioniert — sie tragen stets dieselbe
 * Version wie diese CLI (siehe scripts/bump.sh). Daher aus der eigenen package.json
 * ableiten statt hartcodieren: ein Release zieht die Consumer-Pins automatisch nach
 * (vorausgesetzt ein frischer Build, den prepublishOnly garantiert).
 */
/** Version dieser CLI — Quelle für das `harness`-Feld im Projekt-Manifest. */
export const CLI_VERSION = cliPkg.version;

const SELF = `^${cliPkg.version}`;

/** Gepinnte Versionen, die `udx init`/`udx sync` in Consumer-Projekte schreiben. */
export const VERSIONS = {
  '@biomejs/biome': '^2.4.16',
  '@commitlint/cli': '^21.0.2',
  lefthook: '^1.13.6',
  'git-cliff': '^2.13.1',
  '@types/node': '^25.9.2',
  'bun-types': '^1.3.14',
  typescript: '^6.0.3',
  '@urbicon/biome-config': SELF,
  '@urbicon/commitlint-config': SELF,
  '@urbicon/tsconfig': SELF,
  // nur Svelte-Projekte
  prettier: '^3.8.3',
  'prettier-plugin-svelte': '^4.0.1',
  'prettier-plugin-tailwindcss': '^0.8.0',
  'svelte-check': '^4.3.1'
} as const;

export type DepName = keyof typeof VERSIONS;
