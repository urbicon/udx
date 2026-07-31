import type { ProjectContext } from './detect.ts';
import { abs, exists, readText } from './fs.ts';
import type { DepName } from './versions.ts';
import { resolveWorkspaces } from './workspace.ts';

/**
 * Wiring awareness: the @urbicon-ui config packages are only useful if the consuming
 * config actually references them (biome.json `extends`, commitlint `createConfig`, tsconfig `extends`).
 * If a self-managed config exists that does NOT reference the package, its devDep would be dead
 * weight — udx then doesn't add it and reports the gap (instead of silently dragging it along).
 */
export type WiringStatus =
  /** The consuming config references the @urbicon-ui package. */
  | 'wired'
  /** The config exists but doesn't reference it (self-managed). */
  | 'self-managed'
  /** No consuming config present — udx creates it wired up. */
  | 'absent';

export interface WiringState {
  /** FILE_TEMPLATE id (for `udx sync --only <id> --force`). */
  id: string;
  dep: DepName;
  label: string;
  /** Human-readable name of the consuming config (for the message). */
  consuming: string;
  status: WiringStatus;
}

interface ConfigDef extends Omit<WiringState, 'status'> {
  /** Absolute paths of the files that could reference the package (first match wins). */
  candidates: (ctx: ProjectContext) => string[];
}

const CONFIGS: ConfigDef[] = [
  {
    id: 'biome',
    dep: '@urbicon-ui/biome-config',
    label: 'Biome preset',
    consuming: 'biome.json',
    candidates: (ctx) => [abs(ctx.cwd, 'biome.json')]
  },
  {
    id: 'commitlint',
    dep: '@urbicon-ui/commitlint-config',
    label: 'Commitlint preset',
    consuming: 'commitlint.config.mjs',
    candidates: (ctx) =>
      ['mjs', 'js', 'cjs', 'ts'].map((e) => abs(ctx.cwd, `commitlint.config.${e}`))
  },
  {
    id: 'tsconfig',
    dep: '@urbicon-ui/tsconfig',
    label: 'tsconfig preset',
    consuming: 'tsconfig.json',
    // package-scoped: root + every workspace package (in a monorepo udx writes a tsconfig per package).
    candidates: (ctx) =>
      [ctx.cwd, ...resolveWorkspaces(ctx.cwd, ctx.pkg).map((w) => abs(ctx.cwd, w))].map((d) =>
        abs(d, 'tsconfig.json')
      )
  }
];

/**
 * Checks the candidates: if any references `dep` → `wired`; if at least one exists without a
 * reference → `self-managed`; if none exist → `absent`. Robust string match, since jsonc (comments)
 * and `.mjs` aren't safely parsable as JSON.
 *
 * Aggregate: even ONE wired candidate yields `wired` (e.g. in a monorepo where one package extends
 * the preset but the root tsconfig is self-managed). Deliberately so — the question here is "is the
 * dep used anywhere?". Stricter ("all must be wired") would wrongly drop a legitimate dep.
 */
function scan(paths: string[], dep: string): WiringStatus {
  let present = false;
  for (const p of paths) {
    if (!exists(p)) continue;
    present = true;
    if (readText(p).includes(dep)) return 'wired';
  }
  return present ? 'self-managed' : 'absent';
}

/** Determines the wiring status per @urbicon-ui config package. Read-only. */
export function detectWiring(ctx: ProjectContext): WiringState[] {
  return CONFIGS.map(({ candidates, ...rest }) => ({
    ...rest,
    status: scan(candidates(ctx), rest.dep)
  }));
}

/**
 * @urbicon-ui deps that should NOT be added because the consuming config doesn't use them
 * (self-managed) — feeds the `skip.devDeps` set of `computePkgPlan`. `absent` does NOT count:
 * there udx creates the config wired up, so the dep belongs.
 */
export function wiringSkipDeps(states: WiringState[]): Set<string> {
  return new Set(states.filter((s) => s.status === 'self-managed').map((s) => s.dep));
}
