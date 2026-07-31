import { dirname } from 'node:path';
import type { PackageJson } from './detect.ts';
import { abs, exists } from './fs.ts';

/** Extracts the workspace globs — array form (`["packages/*"]`) or object form (`{ packages: [...] }`, e.g. Bun catalogs). */
function workspaceGlobs(pkg: PackageJson): string[] {
  const ws = pkg.workspaces;
  if (Array.isArray(ws)) return ws.filter((g): g is string => typeof g === 'string');
  if (ws && typeof ws === 'object') {
    const packages = (ws as { packages?: unknown }).packages;
    if (Array.isArray(packages)) return packages.filter((g): g is string => typeof g === 'string');
  }
  return [];
}

/**
 * Resolves the workspace packages to relative directories (each with its own package.json).
 * Empty array ⇒ no monorepo. Uses `Bun.Glob`; the result is sorted & deduplicated.
 */
export function resolveWorkspaces(cwd: string, pkg: PackageJson): string[] {
  const dirs = new Set<string>();
  for (const g of workspaceGlobs(pkg)) {
    const glob = new Bun.Glob(`${g}/package.json`);
    for (const match of glob.scanSync({ cwd, onlyFiles: true })) dirs.add(dirname(match));
  }
  return [...dirs].sort();
}

/**
 * Heuristic: does a workspace package need a (udx-managed) tsconfig? Pure asset packages
 * (e.g. JSON config packages without TS code) should not get one — otherwise `init` creates
 * unnecessary tsconfigs everywhere and `doctor` reports false gaps.
 */
export function isTypeScriptPackage(dir: string, pkg: PackageJson): boolean {
  if (exists(abs(dir, 'tsconfig.json'))) return true; // already a TS package
  if (exists(abs(dir, 'src'))) return true; // has a source directory
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return Boolean(deps.typescript || deps['@urbicon-ui/tsconfig'] || deps.svelte);
}
