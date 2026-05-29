import type { PackageJson, ProjectContext } from './detect.ts';
import { type DepName, VERSIONS } from './versions.ts';

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
}

export function canonicalScripts(ctx: ProjectContext): Record<string, string> {
  const format = ctx.svelte
    ? 'biome format --write . && prettier --write "**/*.svelte"'
    : 'biome format --write .';
  const lint = ctx.svelte
    ? 'biome check . && svelte-check --tsconfig ./tsconfig.json'
    : 'biome check .';
  return {
    format,
    lint,
    fix: 'biome check --write .',
    changelog: 'git-cliff --output CHANGELOG.md',
    bump: 'bash scripts/bump.sh patch',
    'bump:minor': 'bash scripts/bump.sh minor',
    'bump:major': 'bash scripts/bump.sh major',
    prepare: 'lefthook install'
  };
}

export function canonicalDevDeps(ctx: ProjectContext): Partial<Record<DepName, string>> {
  const base: DepName[] = [
    '@biomejs/biome',
    '@commitlint/cli',
    'lefthook',
    'git-cliff',
    'typescript',
    '@types/node',
    'bun-types',
    '@urbicon/biome-config',
    '@urbicon/commitlint-config',
    '@urbicon/tsconfig'
  ];
  const svelteOnly: DepName[] = [
    'prettier',
    'prettier-plugin-svelte',
    'prettier-plugin-tailwindcss',
    'svelte-check'
  ];
  const names = ctx.svelte ? [...base, ...svelteOnly] : base;
  const out: Partial<Record<DepName, string>> = {};
  for (const n of names) out[n] = VERSIONS[n];
  return out;
}

export function computePkgPlan(ctx: ProjectContext): PkgPlan {
  const plan: PkgPlan = { scriptsToAdd: [], scriptsDrift: [], devDepsToAdd: [], devDepsDrift: [] };
  const scripts = ctx.pkg.scripts ?? {};
  const devDeps = ctx.pkg.devDependencies ?? {};

  for (const [name, to] of Object.entries(canonicalScripts(ctx))) {
    const current = scripts[name];
    if (current === undefined) plan.scriptsToAdd.push({ name, to });
    else if (current !== to) plan.scriptsDrift.push({ name, to, from: current });
  }

  for (const [name, to] of Object.entries(canonicalDevDeps(ctx))) {
    const current = devDeps[name];
    if (current === undefined) plan.devDepsToAdd.push({ name, to: to as string });
    // `workspace:*` (Monorepo-interne Pakete) gilt als erfüllt — kein Drift.
    else if (!current.startsWith('workspace:') && current !== to) {
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

/** Wendet den Plan auf das pkg-Objekt an. `force` aktualisiert auch Drift. Gibt true zurück, wenn geändert. */
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
  if (force) {
    for (const ch of plan.scriptsDrift) {
      scripts[ch.name] = ch.to;
      changed = true;
    }
    for (const ch of plan.devDepsDrift) {
      devDeps[ch.name] = ch.to;
      changed = true;
    }
  }

  if (changed) {
    if (Object.keys(scripts).length > 0) pkg.scripts = scripts;
    if (Object.keys(devDeps).length > 0) pkg.devDependencies = sortKeys(devDeps);
  }
  return changed;
}
