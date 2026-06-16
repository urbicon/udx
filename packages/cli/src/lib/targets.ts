import { type CatalogTables, readCatalogTables } from './catalog.ts';
import { detectContext, type ProjectContext } from './detect.ts';
import { abs } from './fs.ts';
import {
  applyCatalogEntries,
  type CatalogChange,
  computePkgPlan,
  type DepTier,
  type PkgFilter,
  type PkgPlan
} from './pkg.ts';
import { isTypeScriptPackage, resolveWorkspaces } from './workspace.ts';

/** A TS workspace package: workspace path + its context (asset packages without TS code are filtered out). */
export interface TsPackage {
  ws: string;
  ctx: ProjectContext;
}

/**
 * Shared workspace view for init/sync (harness), status, and doctor — bundles the three otherwise
 * triple-duplicated determinations in one place (prevents divergence):
 * - `catalog` (from the root pkg): `null` ⇒ literal mode, otherwise catalog mode (D9-A).
 * - `rootTier`: the placement tier of the root pkg patch — `root` in the non-svelte monorepo,
 *   otherwise `undefined` (= everything; a svelte root or single-package).
 * - `tsPkgs`: all TS packages of the monorepo (for package-scoped files and the per-package plan).
 */
export interface WorkspaceView {
  /** Root context (workspace root). */
  rootCtx: ProjectContext;
  catalog: CatalogTables | null;
  isMonorepo: boolean;
  rootTier: DepTier | undefined;
  tsPkgs: TsPackage[];
  /** true if the root or any workspace package is svelte — controls root-scoped Svelte building blocks. */
  svelteAnywhere: boolean;
  /** Raw workspace paths (before the TS filter) — for count messages. */
  workspaces: string[];
}

export function resolveWorkspaceView(
  ctx: ProjectContext,
  svelte: boolean | undefined
): WorkspaceView {
  const workspaces = resolveWorkspaces(ctx.cwd, ctx.pkg);
  const isMonorepo = workspaces.length > 0;
  const tsPkgs: TsPackage[] = isMonorepo
    ? workspaces
        .map((ws) => ({ ws, ctx: detectContext(abs(ctx.cwd, ws), svelte) }))
        .filter(({ ctx: pkgCtx }) => isTypeScriptPackage(pkgCtx.cwd, pkgCtx.pkg))
    : [];
  // A svelte root (or single-package) carries everything (no tier filter); only the non-svelte
  // monorepo root restricts itself to the root tier (svelte tooling then lives per Svelte package).
  const rootTier: DepTier | undefined = isMonorepo && !ctx.svelte ? 'root' : undefined;
  // The lefthook.yml + .prettierrc/.prettierignore are root-scoped, but must cover `.svelte` from all
  // packages — hence "svelte anywhere" instead of only at the (often non-svelte in a monorepo) root.
  const svelteAnywhere = ctx.svelte || tsPkgs.some(({ ctx: pkgCtx }) => pkgCtx.svelte);
  return {
    rootCtx: ctx,
    catalog: readCatalogTables(ctx.pkg),
    isMonorepo,
    rootTier,
    tsPkgs,
    svelteAnywhere,
    workspaces
  };
}

/** A package.json patch target with its plan: `ws` = '' for the root, otherwise the workspace path. */
export interface TargetPlan {
  ws: string;
  plan: PkgPlan;
}

export interface WorkspacePlan {
  /** Plans per patch target (root first, then Svelte packages) — for devDep/script messages. */
  targets: TargetPlan[];
  /** Effective catalog changes after accumulation across all targets (deduplicated, final maximum). */
  catalogChanges: CatalogChange[];
}

/** Two-level copy of the catalog tables (so the simulation does not alter the consumer snapshot). */
function cloneCatalog(c: CatalogTables): CatalogTables {
  return {
    default: { ...c.default },
    named: Object.fromEntries(Object.entries(c.named).map(([n, t]) => [n, { ...t }]))
  };
}

/** Difference of two catalog states (original → accumulated) as add/drift changes. */
function catalogDiff(orig: CatalogTables, final: CatalogTables): CatalogChange[] {
  const changes: CatalogChange[] = [];
  const tables: [string | null, Record<string, string>, Record<string, string>][] = [
    [null, orig.default, final.default],
    ...Object.entries(final.named).map(
      ([n, t]) =>
        [n, orig.named[n] ?? {}, t] as [string, Record<string, string>, Record<string, string>]
    )
  ];
  for (const [table, before, after] of tables) {
    for (const [name, to] of Object.entries(after)) {
      const from = before[name];
      if (from === undefined) changes.push({ name, table, to });
      else if (from !== to) changes.push({ name, table, from, to });
    }
  }
  return changes;
}

/**
 * Computes the package.json plans of all patch targets (root + Svelte packages) **with catalog
 * accumulation** — exactly like the real `sync` (harness): each target sees the entries raised by the
 * previous one, so status/doctor report exactly what `sync` writes (the final maximum, D9-E). Works on
 * a catalog copy, thus leaving the consumer snapshot untouched (read-only safe).
 */
export function planWorkspace(view: WorkspaceView, filter: PkgFilter): WorkspacePlan {
  const sim = view.catalog ? cloneCatalog(view.catalog) : null;
  const targets: TargetPlan[] = [];
  const rootPlan = computePkgPlan(view.rootCtx, filter, view.rootTier, sim);
  applyCatalogEntries(sim, rootPlan);
  targets.push({ ws: '', plan: rootPlan });
  for (const { ws, ctx } of view.tsPkgs) {
    if (!ctx.svelte) continue;
    const plan = computePkgPlan(ctx, filter, 'svelte', sim);
    applyCatalogEntries(sim, plan);
    targets.push({ ws, plan });
  }
  const catalogChanges = view.catalog && sim ? catalogDiff(view.catalog, sim) : [];
  return { targets, catalogChanges };
}
