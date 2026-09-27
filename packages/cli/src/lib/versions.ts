import rootPkg from '../../../../package.json' with { type: 'json' };
import cliPkg from '../../package.json' with { type: 'json' };

/**
 * The @urbicon-ui config packages are versioned in unison — they always carry the same
 * version as this CLI (see scripts/bump.sh). Therefore derive it from the own package.json
 * instead of hardcoding: a release pulls the consumer pins along automatically
 * (assuming a fresh build, which prepublishOnly guarantees).
 */
/** Version of this CLI — source for the `harness` field in the project manifest. */
export const CLI_VERSION = cliPkg.version;

const SELF = `^${cliPkg.version}`;

/**
 * The single source of truth for the prescribed tool versions is the Bun catalog of the
 * root `package.json` (`workspaces.catalog` + `catalogs.svelte`). udx's own packages reference
 * it via `catalog:`, so that `bun outdated`/a bump there propagates automatically into the
 * consumer pins derived here. `bun build` inlines the root `package.json` (verified), so at
 * runtime no file access is needed.
 */
const ws = (
  rootPkg as {
    workspaces: { catalog: Record<string, string>; catalogs: { svelte: Record<string, string> } };
  }
).workspaces;

/** Tool deps that udx writes into every project (from the default catalog). */
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
 * Former names of a dep (new → old). `udx sync` removes the old name when it writes the
 * new one — otherwise existing projects would keep both around (e.g. `bun-types` next to
 * `@types/bun`, which produces duplicate Bun globals when the versions diverge).
 * The `@urbicon/*` entries cover the 2026-07 scope move to `@urbicon-ui/*`: the old scope
 * only ever existed on Codeberg and receives no further releases. Note that a consumer whose
 * config still *references* the old package counts as self-managed (wiring), so the swap only
 * happens once the config points at the new name — `udx sync --only <id> --force` rewrites it.
 */
export const RENAMED_FROM: Partial<Record<DepName, string>> = {
  '@types/bun': 'bun-types',
  '@urbicon-ui/biome-config': '@urbicon/biome-config',
  '@urbicon-ui/commitlint-config': '@urbicon/commitlint-config',
  '@urbicon-ui/tsconfig': '@urbicon/tsconfig',
  '@urbicon-ui/udx': '@urbicon/udx'
};

/** Deps written only into Svelte projects (from the `svelte` catalog). */
export const SVELTE_DEPS = [
  'prettier',
  'prettier-plugin-svelte',
  'prettier-plugin-tailwindcss',
  'svelte-check'
] as const;

/**
 * udx's own packages — the config presets and the CLI itself (which a project needs locally once a
 * script calls `udx`, e.g. `docs:check`). Unified with the CLI version, hence not in the catalog.
 */
export const URBICON_DEPS = [
  '@urbicon-ui/biome-config',
  '@urbicon-ui/commitlint-config',
  '@urbicon-ui/tsconfig',
  '@urbicon-ui/udx'
] as const;

export type DepName =
  | (typeof TOOL_DEPS)[number]
  | (typeof SVELTE_DEPS)[number]
  | (typeof URBICON_DEPS)[number];

/**
 * Reads the `names` from a catalog table and preserves their precise key types (via the
 * generic `N`), so that the spreads in `VERSIONS` together cover all of `DepName`. If an
 * entry is missing, the catalog is incomplete → a loud error instead of a silent `undefined`.
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
        `udx: catalog entry missing for "${n}" (root package.json workspaces.catalog)`
      );
    }
    out[n as N[number]] = v;
  }
  return out;
}

/** Pins every one of `names` to this CLI's own version (`^<version>`). */
function unified<N extends readonly string[]>(names: N): Record<N[number], string> {
  return Object.fromEntries(names.map((n) => [n, SELF])) as Record<N[number], string>;
}

/**
 * Pinned versions that `udx init`/`udx sync` write into consumer projects — derived from the
 * catalog (tool + Svelte deps) and from this CLI's version (`URBICON_DEPS`).
 */
export const VERSIONS: Record<DepName, string> = {
  ...pick(ws.catalog, TOOL_DEPS),
  ...pick(ws.catalogs.svelte, SVELTE_DEPS),
  ...unified(URBICON_DEPS)
};
