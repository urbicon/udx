import type { PackageJson, ProjectContext } from './detect.ts';
import { type DepName, SVELTE_DEPS, TOOL_DEPS, URBICON_DEPS, VERSIONS } from './versions.ts';

export interface PkgChange {
  name: string;
  to: string;
  from?: string;
}

export interface PkgPlan {
  scriptsToAdd: PkgChange[];
  scriptsDrift: PkgChange[];
  devDepsToAdd: PkgChange[];
  devDepsDrift: PkgChange[];
  /** Hinter dem Pin, aber bewusst gehalten (`udx pin`) — wird nicht angehoben, nur zur Sicht gemeldet. */
  devDepsPinned: PkgChange[];
}

/**
 * Platzierungs-Tier eines Bausteins im Monorepo (D9-C):
 * - `root`   – repo-globale Tools + TS-Toolchain + nicht-svelte Lint/Format (laufen einmal fürs Repo).
 * - `svelte` – svelte-Deps + svelte-flavored Lint/Format, je Svelte-Paket (svelte-check braucht die
 *   Paket-eigene tsconfig).
 * Kein Tier (Single-Package) = beide kombiniert, exakt das bisherige Verhalten.
 */
export type DepTier = 'root' | 'svelte';

const SVELTE_FORMAT = 'biome format --write . && prettier --write "**/*.svelte"';
const SVELTE_LINT = 'biome check . && svelte-check --tsconfig ./tsconfig.json';
const BASE_FORMAT = 'biome format --write .';
const BASE_LINT = 'biome check .';

/** Repo-globale Scripts — laufen einmal fürs ganze Projekt, nie per Sub-Paket. */
const REPO_GLOBAL_SCRIPTS: Record<string, string> = {
  fix: 'biome check --write .',
  changelog: 'git-cliff --output CHANGELOG.md',
  bump: 'bash scripts/bump.sh patch',
  'bump:minor': 'bash scripts/bump.sh minor',
  'bump:major': 'bash scripts/bump.sh major',
  prepare: 'lefthook install'
};

export function canonicalScripts(ctx: ProjectContext, tier?: DepTier): Record<string, string> {
  // svelte-Tier: nur die svelte-flavored Format/Lint (per Svelte-Paket); ohne Svelte leer.
  if (tier === 'svelte') return ctx.svelte ? { format: SVELTE_FORMAT, lint: SVELTE_LINT } : {};
  // root-Tier: repo-globale Scripts + nicht-svelte Format/Lint (biome deckt alle Pakete ab).
  if (tier === 'root') return { format: BASE_FORMAT, lint: BASE_LINT, ...REPO_GLOBAL_SCRIPTS };
  // Kein Tier (Single-Package): alles, svelte-flavored falls svelte — bisheriges Verhalten.
  const format = ctx.svelte ? SVELTE_FORMAT : BASE_FORMAT;
  const lint = ctx.svelte ? SVELTE_LINT : BASE_LINT;
  return { format, lint, ...REPO_GLOBAL_SCRIPTS };
}

/** root-Tier devDeps: repo-globale Tools + TS-Toolchain + @urbicon-Presets (alles außer svelte). */
const ROOT_TIER_DEPS: readonly DepName[] = [...TOOL_DEPS, ...URBICON_DEPS];

export function canonicalDevDeps(
  ctx: ProjectContext,
  tier?: DepTier
): Partial<Record<DepName, string>> {
  const out: Partial<Record<DepName, string>> = {};
  const add = (names: readonly DepName[]) => {
    for (const n of names) out[n] = VERSIONS[n];
  };
  if (tier === undefined || tier === 'root') add(ROOT_TIER_DEPS);
  if ((tier === undefined || tier === 'svelte') && ctx.svelte) add(SVELTE_DEPS);
  return out;
}

/**
 * Floor (untere Schranke) einer Range: `^1.2.3`→`1.2.3`, `>=2.0.0 <3`→`2.0.0`, `<3 >=2`→`2.0.0`.
 * Obergrenzen (`<…`) werden übersprungen, damit auch umgekehrt notierte Compound-Ranges den
 * tatsächlichen Floor liefern (nicht versehentlich die Obergrenze).
 */
function floorVersion(range: string): string | null {
  for (const token of range.trim().split(/\s+/)) {
    if (token.startsWith('<')) continue; // Obergrenze ist nicht der Floor
    const m = token.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
    if (m) return m[0];
  }
  return null;
}

/**
 * Die Pins in `versions.ts` sind eine **Baseline** (Mindestversion), kein exakter Sollwert: hat ein
 * Projekt bereits eine neuere, kompatible Version, ist der Pin erfüllt — udx zieht Projekte aufs
 * Minimum hoch, setzt sie aber nie herunter (sonst entstünde das @types/node-Downgrade). Nur eine
 * echt ältere Version gilt als Drift. Nicht-Versions-Specifier (`workspace:`/`catalog:`/`npm:`-Alias,
 * git-URL, `*`, …) regeln die Version anderswo bzw. zeigen auf ein anderes Paket und gelten als
 * erfüllt — ein Downgrade von etwas, das wir nicht semantisch vergleichen können, wäre gefährlich.
 */
export function satisfiesPin(current: string, pin: string): boolean {
  // Nur reine Versions-Ranges vergleichen: führende Operatoren erlaubt, dann eine Ziffer. Protokolle
  // (`workspace:`/`catalog:`/`npm:`/`github:`/`git+…`) beginnen mit einem Buchstaben → gelten als erfüllt.
  if (!/^[v^~>=<\s]*\d/.test(current)) return true;
  const cur = floorVersion(current);
  const want = floorVersion(pin);
  if (cur === null || want === null) return true;
  return Bun.semver.order(cur, want) >= 0;
}

export interface PkgSet {
  scripts?: ReadonlySet<string>;
  devDeps?: ReadonlySet<string>;
}

/** Filter für den Plan: `skip` nimmt Bausteine raus (abgewählt), `only` beschränkt (Whitelist), `pinned` hält devDeps. */
export interface PkgFilter {
  skip?: PkgSet;
  only?: PkgSet;
  pinned?: ReadonlySet<string>;
}

export function computePkgPlan(
  ctx: ProjectContext,
  filter: PkgFilter = {},
  tier?: DepTier
): PkgPlan {
  const plan: PkgPlan = {
    scriptsToAdd: [],
    scriptsDrift: [],
    devDepsToAdd: [],
    devDepsDrift: [],
    devDepsPinned: []
  };
  const scripts = ctx.pkg.scripts ?? {};
  const devDeps = ctx.pkg.devDependencies ?? {};
  const { skip, only, pinned } = filter;

  for (const [name, to] of Object.entries(canonicalScripts(ctx, tier))) {
    if (only?.scripts && !only.scripts.has(name)) continue;
    if (skip?.scripts?.has(name)) continue;
    const current = scripts[name];
    if (current === undefined) plan.scriptsToAdd.push({ name, to });
    else if (current !== to) plan.scriptsDrift.push({ name, to, from: current });
  }

  for (const [name, to] of Object.entries(canonicalDevDeps(ctx, tier))) {
    if (only?.devDeps && !only.devDeps.has(name)) continue;
    if (skip?.devDeps?.has(name)) continue;
    const current = devDeps[name];
    // Bewusst gehalten (`udx pin`) → unberührt lassen (kein Anheben, kein Ergänzen), aber stets
    // melden — auch wenn nicht installiert —, damit ein aktiver Pin nie still „verschwindet".
    if (pinned?.has(name)) {
      plan.devDepsPinned.push(
        current !== undefined
          ? { name, to: to as string, from: current }
          : { name, to: to as string }
      );
      continue;
    }
    if (current === undefined) plan.devDepsToAdd.push({ name, to: to as string });
    // Drift nur, wenn das Projekt echt hinter dem Pin liegt (nicht bei neuerer kompatibler Version).
    else if (!satisfiesPin(current, to as string)) {
      plan.devDepsDrift.push({ name, to: to as string, from: current });
    }
  }

  return plan;
}

function sortKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k] as string;
  return out;
}

/**
 * Wendet den Plan auf das pkg-Objekt an. Fehlende Scripts/devDeps und Versions-Drift (Projekt hinter
 * dem Pin) werden immer angewandt — `satisfiesPin` garantiert, dass das nie ein Downgrade ist, daher
 * braucht das kein `--force`. Nur Script-Drift kann eine bewusste Anpassung sein → `--force`.
 * Gibt true zurück, wenn geändert.
 */
export function mutatePkg(pkg: PackageJson, plan: PkgPlan, force: boolean): boolean {
  let changed = false;
  const scripts = { ...(pkg.scripts ?? {}) };
  const devDeps = { ...(pkg.devDependencies ?? {}) };

  for (const ch of plan.scriptsToAdd) {
    scripts[ch.name] = ch.to;
    changed = true;
  }
  for (const ch of plan.devDepsToAdd) {
    devDeps[ch.name] = ch.to;
    changed = true;
  }
  // Sicheres Anheben hinter dem Pin liegender Versionen (nie Downgrade) — ohne --force.
  for (const ch of plan.devDepsDrift) {
    devDeps[ch.name] = ch.to;
    changed = true;
  }
  if (force) {
    for (const ch of plan.scriptsDrift) {
      scripts[ch.name] = ch.to;
      changed = true;
    }
  }

  if (changed) {
    if (Object.keys(scripts).length > 0) pkg.scripts = scripts;
    if (Object.keys(devDeps).length > 0) pkg.devDependencies = sortKeys(devDeps);
  }
  return changed;
}
