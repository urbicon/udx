import { basename, dirname } from 'node:path';
import { readCatalogTables } from './catalog.ts';
import { abs, exists, readJson } from './fs.ts';

export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
  [key: string]: unknown;
}

export interface ProjectContext {
  cwd: string;
  projectName: string;
  svelte: boolean;
  pkg: PackageJson;
}

function isSvelteProject(pkg: PackageJson): boolean {
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return Boolean(all.svelte || all['@sveltejs/kit']);
}

/** Leading major of a version or range (`^3.0.0`, `3.0.0-next.27`, `~2.5`). Top-level (regex perf). */
const MAJOR_RE = /^\D*(\d+)/;
const KIT = '@sveltejs/kit';

/** First existing `<dir>/<rel>` from `start` upwards — node-style resolution. */
function findUp(start: string, rel: string): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = abs(dir, rel);
    if (exists(candidate)) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/** Kit's entry in the nearest catalog (the project's own, else a workspace root's above it). */
function catalogKit(ctx: ProjectContext, name: string): string | undefined {
  let tables = readCatalogTables(ctx.pkg);
  for (let dir = dirname(ctx.cwd); !tables; dir = dirname(dir)) {
    const pkgPath = abs(dir, 'package.json');
    if (exists(pkgPath)) tables = readCatalogTables(readJson<PackageJson>(pkgPath));
    if (dirname(dir) === dir) break;
  }
  return (name ? tables?.named[name] : tables?.default)?.[KIT];
}

/**
 * Major version of SvelteKit a project targets — `null` without a declared `@sveltejs/kit`. Taken
 * from the declared range (a `catalog:` reference resolved against the nearest catalog), else — for a
 * range naming no version (`latest`, `workspace:*`) — from the installed package.
 */
export function svelteKitMajor(ctx: ProjectContext): number | null {
  const declared = ctx.pkg.dependencies?.[KIT] ?? ctx.pkg.devDependencies?.[KIT];
  if (!declared) return null;
  const spec = declared.startsWith('catalog:')
    ? catalogKit(ctx, declared.slice('catalog:'.length))
    : declared;
  const fromSpec = spec?.match(MAJOR_RE)?.[1];
  if (fromSpec) return Number(fromSpec);
  const installed = findUp(ctx.cwd, `node_modules/${KIT}/package.json`);
  const fromInstalled = installed && readJson<PackageJson>(installed).version?.match(MAJOR_RE)?.[1];
  return fromInstalled ? Number(fromInstalled) : null;
}

/**
 * SvelteKit ≥ 3: the generated tsconfig lives in node_modules (`$app/tsconfig`, written by
 * `svelte-kit sync`) instead of `.svelte-kit/tsconfig.json` — templates and scripts differ.
 */
export function usesKit3(ctx: ProjectContext): boolean {
  return (svelteKitMajor(ctx) ?? 0) >= 3;
}

/** Reads the project context from cwd. `svelteOverride` forces Svelte detection. */
export function detectContext(cwd: string, svelteOverride?: boolean): ProjectContext {
  const pkgPath = abs(cwd, 'package.json');
  const pkg: PackageJson = exists(pkgPath) ? readJson<PackageJson>(pkgPath) : {};

  return {
    cwd,
    projectName: pkg.name ?? basename(cwd),
    svelte: svelteOverride ?? isSvelteProject(pkg),
    pkg
  };
}
