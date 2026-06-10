import rootPkg from '../../../../package.json' with { type: 'json' };
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

/**
 * Single Source of Truth für die vorgeschriebenen Tool-Versionen ist der Bun-Catalog der
 * Root-`package.json` (`workspaces.catalog` + `catalogs.svelte`). udx' eigene Pakete referenzieren
 * ihn via `catalog:`, sodass `bun outdated`/ein Bump dort automatisch in die hier abgeleiteten
 * Consumer-Pins propagiert. `bun build` inlined die Root-`package.json` (verifiziert), zur Laufzeit
 * ist also kein Dateizugriff nötig.
 */
const ws = (
  rootPkg as {
    workspaces: { catalog: Record<string, string>; catalogs: { svelte: Record<string, string> } };
  }
).workspaces;

/** Tool-Deps, die udx in jedes Projekt schreibt (aus dem Default-Catalog). */
export const TOOL_DEPS = [
  '@biomejs/biome',
  '@commitlint/cli',
  'lefthook',
  'git-cliff',
  '@types/node',
  '@types/bun',
  'typescript'
] as const;

/**
 * Frühere Namen eines Tool-Deps (neu → alt). `udx sync` entfernt den alten Namen, wenn er den
 * neuen schreibt — sonst bliebe in Bestandsprojekten beides liegen (z. B. `bun-types` neben
 * `@types/bun`, was bei divergierenden Versionen doppelte Bun-Globals erzeugt).
 */
export const RENAMED_FROM: Partial<Record<DepName, string>> = {
  '@types/bun': 'bun-types'
};

/** Nur in Svelte-Projekte geschriebene Deps (aus dem `svelte`-Catalog). */
export const SVELTE_DEPS = [
  'prettier',
  'prettier-plugin-svelte',
  'prettier-plugin-tailwindcss',
  'svelte-check'
] as const;

/** udx-eigene Config-Pakete — unified mit der CLI-Version, daher nicht im Catalog. */
export const URBICON_DEPS = [
  '@urbicon/biome-config',
  '@urbicon/commitlint-config',
  '@urbicon/tsconfig'
] as const;

export type DepName =
  | (typeof TOOL_DEPS)[number]
  | (typeof SVELTE_DEPS)[number]
  | (typeof URBICON_DEPS)[number];

/**
 * Liest die `names` aus einer Catalog-Tabelle und behält deren präzise Key-Typen (über das
 * generische `N`), sodass die Spreads in `VERSIONS` zusammen alle `DepName` abdecken. Fehlt ein
 * Eintrag, ist der Catalog unvollständig → lauter Fehler statt stillem `undefined`.
 */
function pick<N extends readonly string[]>(
  table: Record<string, string>,
  names: N
): Record<N[number], string> {
  const out = {} as Record<N[number], string>;
  for (const n of names) {
    const v = table[n];
    if (v === undefined) {
      throw new Error(
        `udx: Catalog-Eintrag fehlt für "${n}" (Root-package.json workspaces.catalog)`
      );
    }
    out[n as N[number]] = v;
  }
  return out;
}

/** Gepinnte Versionen, die `udx init`/`udx sync` in Consumer-Projekte schreiben — aus dem Catalog abgeleitet. */
export const VERSIONS: Record<DepName, string> = {
  ...pick(ws.catalog, TOOL_DEPS),
  ...pick(ws.catalogs.svelte, SVELTE_DEPS),
  '@urbicon/biome-config': SELF,
  '@urbicon/commitlint-config': SELF,
  '@urbicon/tsconfig': SELF
};
