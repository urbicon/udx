import { dirname } from 'node:path';
import type { PackageJson } from './detect.ts';
import { abs, exists } from './fs.ts';

/** Extrahiert die Workspace-Globs — Array-Form (`["packages/*"]`) oder Objekt-Form (`{ packages: [...] }`, z. B. Bun-Catalogs). */
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
 * Löst die Workspace-Pakete zu relativen Verzeichnissen auf (jedes mit eigener package.json).
 * Leeres Array ⇒ kein Monorepo. Nutzt `Bun.Glob`; Ergebnis ist sortiert & dedupliziert.
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
 * Heuristik: Braucht ein Workspace-Paket eine (udx-verwaltete) tsconfig? Reine Asset-Pakete
 * (z. B. JSON-Config-Pakete ohne TS-Code) sollen keine bekommen — sonst legt `init` überall
 * unnötige tsconfigs an und `doctor` meldet falsche Lücken.
 */
export function isTypeScriptPackage(dir: string, pkg: PackageJson): boolean {
  if (exists(abs(dir, 'tsconfig.json'))) return true; // bereits ein TS-Paket
  if (exists(abs(dir, 'src'))) return true; // hat ein Quellverzeichnis
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return Boolean(deps.typescript || deps['@urbicon/tsconfig'] || deps.svelte);
}
