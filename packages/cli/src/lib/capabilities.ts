import type { ProjectContext } from './detect.ts';
import { abs, exists } from './fs.ts';
import type { Manifest } from './manifest.ts';
import type { DepName } from './versions.ts';

/**
 * Eine declinebare Stack-Fähigkeit, die Datei(en), Scripts und devDeps bündelt.
 * `supersededBy` erkennt generisch (über deps/Dateien, nie über Projektnamen), ob das
 * Projekt diese Fähigkeit bereits anders löst — dann wird der Baustein automatisch
 * abgewählt und die Entscheidung im Manifest persistiert.
 */
export interface Capability {
  id: string;
  label: string;
  /** Referenzierte FILE_TEMPLATE-Ids (lose über String gekoppelt, per Test abgesichert). */
  files: string[];
  /** Referenzierte canonicalScripts-Schlüssel. */
  scripts: string[];
  devDeps: DepName[];
  /** Erkanntes Konkurrenz-Tool (z. B. `husky`) oder `null`, wenn der Baustein zutrifft. */
  supersededBy: (ctx: ProjectContext) => string | null;
}

function hasDep(ctx: ProjectContext, name: string): boolean {
  return Boolean(ctx.pkg.dependencies?.[name] ?? ctx.pkg.devDependencies?.[name]);
}

function hasPath(ctx: ProjectContext, rel: string): boolean {
  return exists(abs(ctx.cwd, rel));
}

export const CAPABILITIES: Capability[] = [
  {
    id: 'git-hooks',
    label: 'Git-Hooks (lefthook)',
    files: ['lefthook'],
    scripts: ['prepare'],
    devDeps: ['lefthook'],
    supersededBy: (ctx) => {
      if (hasDep(ctx, 'husky') || hasPath(ctx, '.husky')) return 'husky';
      if (hasDep(ctx, 'simple-git-hooks')) return 'simple-git-hooks';
      return null;
    }
  },
  {
    id: 'lint-format',
    label: 'Lint/Format (biome)',
    files: ['biome'],
    scripts: ['lint', 'format', 'fix'],
    // Biome-Kern + die svelte-spezifische Lint/Format-Kette. `prettier` selbst bleibt
    // bewusst draußen: es teilt sich der git-hooks-Prettier-Hook (sonst Lücke andersrum).
    // Bei Nicht-Svelte-Projekten fehlen die svelte-Deps ohnehin im Plan — die Skip-Menge
    // läuft dann ins Leere (harmlos).
    devDeps: [
      '@biomejs/biome',
      '@urbicon/biome-config',
      'prettier-plugin-svelte',
      'prettier-plugin-tailwindcss',
      'svelte-check'
    ],
    supersededBy: (ctx) => (hasDep(ctx, 'eslint') ? 'eslint' : null)
  }
];

export function findCapability(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

export interface CapabilityState {
  cap: Capability;
  declined: boolean;
  /** Grund der Abwahl (erkanntes Tool oder `manual`); leer, wenn aktiv. */
  reason: string;
  /** In diesem Lauf erstmals erkannt — noch nicht im Manifest persistiert. */
  fresh: boolean;
  /** Auto-abgewählt, aber das damals erkannte Tool ist nicht mehr da (Grund veraltet). */
  stale: boolean;
}

/**
 * Bestimmt je Capability den Zustand. Rein (mutiert nichts). Priorität:
 * `adopted` (explizit aktiv, überstimmt jede Auto-Abwahl) → `declined` (im Manifest vermerkt)
 * → `supersededBy` (frische Auto-Abwahl, `fresh`). Der Caller persistiert frische Abwahlen
 * (init/sync) oder zeigt sie nur an (doctor). Eine persistierte Auto-Abwahl, deren Tool
 * verschwunden ist, wird `stale` markiert (doctor weist darauf hin).
 */
export function resolveCapabilities(ctx: ProjectContext, manifest: Manifest): CapabilityState[] {
  return CAPABILITIES.map((cap) => {
    if (manifest.adopted.includes(cap.id)) {
      return { cap, declined: false, reason: '', fresh: false, stale: false };
    }
    const persisted = manifest.declined[cap.id];
    if (persisted !== undefined) {
      // 'manual' ist eine bewusste Wahl und nie veraltet; ein Tool-Grund schon, wenn es fehlt.
      const stale = persisted !== 'manual' && cap.supersededBy(ctx) === null;
      return { cap, declined: true, reason: persisted, fresh: false, stale };
    }
    const tool = cap.supersededBy(ctx);
    if (tool) return { cap, declined: true, reason: tool, fresh: true, stale: false };
    return { cap, declined: false, reason: '', fresh: false, stale: false };
  });
}

export interface DeclinedSets {
  /** Abgewählte FILE_TEMPLATE-Id → Grund. */
  files: Map<string, string>;
  scripts: Set<string>;
  devDeps: Set<string>;
}

/** Faltet die abgewählten Capabilities zu Skip-Mengen für apply/pkg/doctor zusammen. */
export function declinedSets(states: CapabilityState[]): DeclinedSets {
  const files = new Map<string, string>();
  const scripts = new Set<string>();
  const devDeps = new Set<string>();
  for (const s of states) {
    if (!s.declined) continue;
    for (const f of s.cap.files) files.set(f, s.reason);
    for (const sc of s.cap.scripts) scripts.add(sc);
    for (const d of s.cap.devDeps) devDeps.add(d);
  }
  return { files, scripts, devDeps };
}

export interface Selection {
  /** Ausgewählte FILE_TEMPLATE-Ids. */
  files: Set<string>;
  scripts: Set<string>;
  devDeps: Set<string>;
  /** Bezeichner, die weder Capability noch Datei sind. */
  unknown: string[];
}

/**
 * Löst `--only`-Bezeichner zu konkreten Bausteinen auf. Ein Bezeichner ist entweder eine
 * Capability-Id (expandiert zu deren Datei/Scripts/devDeps) oder eine FILE_TEMPLATE-Id.
 * `validFileIds` kommt vom Caller, damit die lib von den Templates entkoppelt bleibt.
 */
export function resolveSelection(ids: string[], validFileIds: ReadonlySet<string>): Selection {
  const sel: Selection = { files: new Set(), scripts: new Set(), devDeps: new Set(), unknown: [] };
  for (const id of ids) {
    const cap = findCapability(id);
    if (cap) {
      for (const f of cap.files) sel.files.add(f);
      for (const s of cap.scripts) sel.scripts.add(s);
      for (const d of cap.devDeps) sel.devDeps.add(d);
    } else if (validFileIds.has(id)) {
      sel.files.add(id);
    } else {
      sel.unknown.push(id);
    }
  }
  return sel;
}
