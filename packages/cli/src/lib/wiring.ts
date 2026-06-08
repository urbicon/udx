import type { ProjectContext } from './detect.ts';
import { abs, exists, readText } from './fs.ts';
import type { DepName } from './versions.ts';
import { resolveWorkspaces } from './workspace.ts';

/**
 * Verdrahtungs-Bewusstsein: die @urbicon-Config-Pakete bringen nur Nutzen, wenn die konsumierende
 * Config sie auch referenziert (biome.json `extends`, commitlint `createConfig`, tsconfig `extends`).
 * Existiert eine selbstverwaltete Config, die das Paket NICHT referenziert, wäre dessen devDep tote
 * Last — udx ergänzt es dann nicht und meldet die Lücke (statt sie still mitzuschleppen).
 */
export type WiringStatus =
  /** Konsumierende Config referenziert das @urbicon-Paket. */
  | 'wired'
  /** Config existiert, referenziert es aber nicht (selbstverwaltet). */
  | 'self-managed'
  /** Keine konsumierende Config vorhanden — udx legt sie verdrahtet an. */
  | 'absent';

export interface WiringState {
  /** FILE_TEMPLATE-Id (für `udx sync --only <id> --force`). */
  id: string;
  dep: DepName;
  label: string;
  /** Menschlicher Name der konsumierenden Config (für die Meldung). */
  consuming: string;
  status: WiringStatus;
}

interface ConfigDef extends Omit<WiringState, 'status'> {
  /** Absolute Pfade der Dateien, die das Paket referenzieren könnten (erste Treffer entscheiden). */
  candidates: (ctx: ProjectContext) => string[];
}

const CONFIGS: ConfigDef[] = [
  {
    id: 'biome',
    dep: '@urbicon/biome-config',
    label: 'Biome-Preset',
    consuming: 'biome.json',
    candidates: (ctx) => [abs(ctx.cwd, 'biome.json')]
  },
  {
    id: 'commitlint',
    dep: '@urbicon/commitlint-config',
    label: 'Commitlint-Preset',
    consuming: 'commitlint.config.mjs',
    candidates: (ctx) =>
      ['mjs', 'js', 'cjs', 'ts'].map((e) => abs(ctx.cwd, `commitlint.config.${e}`))
  },
  {
    id: 'tsconfig',
    dep: '@urbicon/tsconfig',
    label: 'tsconfig-Preset',
    consuming: 'tsconfig.json',
    // package-scoped: Root + jedes Workspace-Paket (im Monorepo schreibt udx tsconfig je Paket).
    candidates: (ctx) =>
      [ctx.cwd, ...resolveWorkspaces(ctx.cwd, ctx.pkg).map((w) => abs(ctx.cwd, w))].map((d) =>
        abs(d, 'tsconfig.json')
      )
  }
];

/**
 * Prüft die Kandidaten: referenziert irgendeiner `dep` → `wired`; existiert mindestens einer ohne
 * Referenz → `self-managed`; keiner vorhanden → `absent`. Robustes String-Match, da jsonc (Kommentare)
 * und `.mjs` nicht sicher als JSON parsebar sind.
 *
 * Aggregat: schon EIN verdrahteter Kandidat ergibt `wired` (z. B. im Monorepo, wo ein Paket das Preset
 * extendet, der Root-tsconfig aber selbstverwaltet ist). Bewusst so — die Frage hier ist „wird das Dep
 * irgendwo genutzt?". Strenger („alle müssen verdrahten") würde ein berechtigtes Dep fälschlich droppen.
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

/** Bestimmt je @urbicon-Config-Paket den Verdrahtungs-Status. Rein lesend. */
export function detectWiring(ctx: ProjectContext): WiringState[] {
  return CONFIGS.map(({ candidates, ...rest }) => ({
    ...rest,
    status: scan(candidates(ctx), rest.dep)
  }));
}

/**
 * @urbicon-Deps, die NICHT ergänzt werden sollen, weil die konsumierende Config sie nicht nutzt
 * (selbstverwaltet) — speist die `skip.devDeps`-Menge von `computePkgPlan`. `absent` zählt NICHT:
 * dort legt udx die Config verdrahtet an, das Dep gehört also dazu.
 */
export function wiringSkipDeps(states: WiringState[]): Set<string> {
  return new Set(states.filter((s) => s.status === 'self-managed').map((s) => s.dep));
}
