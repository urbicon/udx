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

/** Ein TS-Workspace-Paket: Workspace-Pfad + sein Kontext (Asset-Pakete ohne TS-Code sind ausgefiltert). */
export interface TsPackage {
  ws: string;
  ctx: ProjectContext;
}

/**
 * Gemeinsame Workspace-Sicht für init/sync (harness), status und doctor — bündelt die drei sonst
 * dreifach duplizierten Bestimmungen an einer Stelle (verhindert Divergenz):
 * - `catalog` (aus dem Root-pkg): `null` ⇒ literal-Modus, sonst Catalog-Modus (D9-A).
 * - `rootTier`: das Platzierungs-Tier des Root-pkg-Patches — `root` im nicht-svelte Monorepo, sonst
 *   `undefined` (= alles; ein svelte-Root oder Single-Package).
 * - `tsPkgs`: alle TS-Pakete des Monorepos (für package-scoped Dateien und den per-Paket-Plan).
 */
export interface WorkspaceView {
  /** Root-Kontext (Workspace-Wurzel). */
  rootCtx: ProjectContext;
  catalog: CatalogTables | null;
  isMonorepo: boolean;
  rootTier: DepTier | undefined;
  tsPkgs: TsPackage[];
  /** Rohe Workspace-Pfade (vor dem TS-Filter) — für Anzahl-Meldungen. */
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
  // Ein svelte-Root (oder Single-Package) trägt alles (kein Tier-Filter); nur der nicht-svelte
  // Monorepo-Root beschränkt sich aufs root-Tier (Svelte-Werkzeug liegt dann je Svelte-Paket).
  const rootTier: DepTier | undefined = isMonorepo && !ctx.svelte ? 'root' : undefined;
  return {
    rootCtx: ctx,
    catalog: readCatalogTables(ctx.pkg),
    isMonorepo,
    rootTier,
    tsPkgs,
    workspaces
  };
}

/** Ein package.json-Patch-Ziel mit seinem Plan: `ws` = '' für den Root, sonst der Workspace-Pfad. */
export interface TargetPlan {
  ws: string;
  plan: PkgPlan;
}

export interface WorkspacePlan {
  /** Pläne je Patch-Ziel (Root zuerst, dann Svelte-Pakete) — für devDep-/Script-Meldungen. */
  targets: TargetPlan[];
  /** Effektive Catalog-Änderungen nach Akkumulation über alle Ziele (dedupliziert, finales Maximum). */
  catalogChanges: CatalogChange[];
}

/** Zwei-Ebenen-Kopie der Catalog-Tabellen (damit die Simulation den Consumer-Snapshot nicht verändert). */
function cloneCatalog(c: CatalogTables): CatalogTables {
  return {
    default: { ...c.default },
    named: Object.fromEntries(Object.entries(c.named).map(([n, t]) => [n, { ...t }]))
  };
}

/** Differenz zweier Catalog-Stände (Original → akkumuliert) als Add-/Drift-Änderungen. */
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
 * Berechnet die package.json-Pläne aller Patch-Ziele (Root + Svelte-Pakete) **mit Catalog-Akkumulation**
 * — genau wie der echte `sync` (harness): jedes Ziel sieht die vom vorigen angehobenen Einträge, sodass
 * status/doctor exakt das melden, was `sync` schreibt (das finale Maximum, D9-E). Arbeitet auf einer
 * Catalog-Kopie, lässt den Consumer-Snapshot also unberührt (read-only-tauglich).
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
