import { basename } from 'node:path';
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
  isMonorepo: boolean;
  hasPackageJson: boolean;
  pkg: PackageJson;
}

function isSvelteProject(pkg: PackageJson): boolean {
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return Boolean(all.svelte || all['@sveltejs/kit']);
}

/** Liest den Projektkontext aus cwd. `svelteOverride` erzwingt die Svelte-Erkennung. */
export function detectContext(cwd: string, svelteOverride?: boolean): ProjectContext {
  const pkgPath = abs(cwd, 'package.json');
  const hasPackageJson = exists(pkgPath);
  const pkg: PackageJson = hasPackageJson ? readJson<PackageJson>(pkgPath) : {};

  return {
    cwd,
    projectName: pkg.name ?? basename(cwd),
    svelte: svelteOverride ?? isSvelteProject(pkg),
    isMonorepo: pkg.workspaces !== undefined,
    hasPackageJson,
    pkg
  };
}
