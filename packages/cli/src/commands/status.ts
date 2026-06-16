import { type ApplyOptions, applyFiles, type FileResult, URBICON_REGISTRY } from '../lib/apply.ts';
import { declinedSets, resolveCapabilities } from '../lib/capabilities.ts';
import { c } from '../lib/colors.ts';
import { detectContext, type ProjectContext } from '../lib/detect.ts';
import { abs, exists, readText } from '../lib/fs.ts';
import { log } from '../lib/log.ts';
import { type Manifest, readManifest } from '../lib/manifest.ts';
import {
  type CatalogChange,
  canonicalDevDeps,
  canonicalScripts,
  type PkgPlan
} from '../lib/pkg.ts';
import { planWorkspace, resolveWorkspaceView } from '../lib/targets.ts';
import { detectWiring, wiringSkipDeps } from '../lib/wiring.ts';
import { isTypeScriptPackage, resolveWorkspaces } from '../lib/workspace.ts';
import type { RenderCtx } from '../templates/index.ts';

export interface StatusFlags {
  cwd: string;
  svelte: boolean | undefined;
  /** Structured output for tooling instead of the table. */
  json: boolean;
}

/** Classification of a managed thing — determines glyph, color, and the recommended action. */
type State = 'sync' | 'behind' | 'missing' | 'customized' | 'pinned' | 'declined' | 'unwired';

interface Row {
  state: State;
  label: string;
  detail: string;
  /** Command that resolves this row (shown in the table after the arrow). */
  cmd?: string;
}

interface Section {
  title: string;
  rows: Row[];
}

const GLYPH: Record<State, string> = {
  sync: c.green('✓'),
  behind: c.cyan('↑'),
  missing: c.green('+'),
  customized: c.yellow('✎'),
  pinned: c.gray('⊙'),
  declined: c.gray('⊘'),
  unwired: c.gray('~')
};

/** Maps an applyFiles dry-run result to a status row (declined files are filtered out by `fileRows` beforehand). */
function fileRow(r: FileResult, prefix = ''): Row {
  const label = `${prefix}${r.dest}`;
  switch (r.action) {
    case 'unchanged':
      return { state: 'sync', label, detail: 'up to date' };
    case 'created':
    case 'would-create':
      return { state: 'missing', label, detail: 'missing', cmd: 'udx sync' };
    case 'updated':
    case 'would-update':
      return { state: 'behind', label, detail: 'stale', cmd: 'udx sync' };
    case 'conflict':
      return { state: 'customized', label, detail: 'locally modified', cmd: 'udx sync -i' };
    default:
      // 'skipped' only reaches here for create-only-already-present — declined files are already filtered out.
      return { state: 'sync', label, detail: 'present' };
  }
}

/** Collects all file rows (root + per TS package, package-scoped, in a monorepo). */
function fileRows(
  ctx: ProjectContext,
  declinedFiles: ReadonlyMap<string, string>,
  manifest: Manifest,
  svelteAnywhere: boolean
): Row[] {
  const dry: ApplyOptions = { mode: 'sync', dryRun: true, force: false };
  const workspaces = resolveWorkspaces(ctx.cwd, ctx.pkg);
  const isMonorepo = workspaces.length > 0;
  const rows: Row[] = [];

  // root-scoped files (lefthook, .prettierrc/.prettierignore) must cover `.svelte` from ALL packages,
  // so enrich the root ctx with svelteAnywhere — exactly like sync does. Otherwise a non-svelte root
  // would render e.g. the lefthook prettier line away and status would report perpetual drift.
  const rootCtx: RenderCtx = { ...ctx, svelteAnywhere };
  // Filter out declined files by their id (rather than by the hint text) — they appear under Building blocks.
  const rootOpts = isMonorepo ? { ...dry, scope: 'root' as const } : dry;
  for (const r of applyFiles(ctx.cwd, rootCtx, rootOpts, manifest, declinedFiles)) {
    if (r.id && declinedFiles.has(r.id)) continue;
    rows.push(fileRow(r));
  }
  if (isMonorepo) {
    for (const ws of workspaces) {
      const pkgCtx = detectContext(abs(ctx.cwd, ws), ctx.svelte);
      if (!isTypeScriptPackage(pkgCtx.cwd, pkgCtx.pkg)) continue;
      const res = applyFiles(pkgCtx.cwd, pkgCtx, { ...dry, scope: 'package' }, manifest, new Map());
      for (const r of res) rows.push(fileRow(r, `${ws}/`));
    }
  }
  return rows;
}

/** package.json plan → status rows (prefix = package path in the monorepo). */
function pkgRows(plan: PkgPlan, prefix = ''): Row[] {
  const rows: Row[] = [];
  for (const ch of plan.devDepsToAdd)
    rows.push({
      state: 'missing',
      label: `${prefix}${ch.name}`,
      detail: `missing → ${ch.to}`,
      cmd: 'udx sync'
    });
  for (const ch of plan.devDepsDrift)
    rows.push({
      state: 'behind',
      label: `${prefix}${ch.name}`,
      detail: `${ch.from} → ${ch.to}`,
      cmd: 'udx sync'
    });
  // D9: a literal devDep is switched over to the catalog reference.
  for (const ch of plan.devDepsToCatalog)
    rows.push({
      state: 'behind',
      label: `${prefix}${ch.name}`,
      detail: `${ch.from} → ${ch.to}`,
      cmd: 'udx sync'
    });
  // Renamed tool dep: the old name is removed in favor of its successor.
  for (const ch of plan.devDepsToRemove)
    rows.push({
      state: 'behind',
      label: `${prefix}${ch.name}`,
      detail: `removed (replaced by ${ch.to})`,
      cmd: 'udx sync'
    });
  for (const ch of plan.scriptsToAdd)
    rows.push({
      state: 'missing',
      label: `${prefix}${ch.name} (script)`,
      detail: 'missing',
      cmd: 'udx sync'
    });
  for (const ch of plan.scriptsDrift)
    rows.push({
      state: 'customized',
      label: `${prefix}${ch.name} (script)`,
      detail: 'customized',
      cmd: 'udx sync --force'
    });
  for (const ch of plan.devDepsPinned)
    rows.push({
      state: 'pinned',
      label: `${prefix}${ch.name}`,
      detail: `pinned at ${ch.from ?? '(not installed)'}`,
      cmd: `udx unpin ${ch.name}`
    });
  return rows;
}

/** Label of a catalog entry row (with the named catalog, unless it's the default). */
function catalogLabel(ch: CatalogChange): string {
  return ch.table ? `${ch.name} (catalogs.${ch.table})` : ch.name;
}

/** Builds the full status report — reuses the same engines as init/sync/doctor. */
export function buildReport(flags: StatusFlags): {
  ctx: ProjectContext;
  sections: Section[];
  held: number;
} {
  const ctx = detectContext(flags.cwd, flags.svelte);
  const manifest = readManifest(ctx.cwd);
  const capStates = resolveCapabilities(ctx, manifest);
  const declined = declinedSets(capStates);
  const pinned = new Set(Object.keys(manifest.pinned));

  // Wiring: self-managed configs ⇒ their @urbicon preset dep doesn't count as a target
  // (neither missing nor "in sync"), but instead shows up below as its own row.
  const wiring = detectWiring(ctx);
  const wiringSkip = wiringSkipDeps(wiring);
  const skipDeps = new Set([...declined.devDeps, ...wiringSkip]);

  const blocks: Row[] = capStates.map((s) =>
    s.declined
      ? {
          state: 'declined' as const,
          label: s.cap.label,
          detail: `declined (${s.reason})`,
          cmd: `udx add ${s.cap.id}`
        }
      : { state: 'sync' as const, label: s.cap.label, detail: 'active' }
  );

  // package.json: only the actionable items as rows, the rest as an "in sync" counter. Monorepo: the
  // root carries the root tier (a svelte root = everything); each Svelte package its svelte tier (D9-C).
  // In catalog mode (D9-A) tool versions are tracked as catalog: and their entries maintained.
  const view = resolveWorkspaceView(ctx, flags.svelte);
  const { rootTier } = view; // for the root-tier "in sync" counter; catalog uses planWorkspace internally

  const files = fileRows(ctx, declined.files, manifest, view.svelteAnywhere);
  const skipFilter = { skip: { scripts: declined.scripts, devDeps: skipDeps }, pinned };

  // Plan with catalog accumulation (like the real sync) — so status reports exactly its result.
  const { targets, catalogChanges } = planWorkspace(view, skipFilter);
  const plan = targets[0]?.plan as PkgPlan; // root plan (always present)
  const pkg: Row[] = targets.flatMap((t) => pkgRows(t.plan, t.ws ? `${t.ws}/` : ''));
  const held = targets.reduce((n, t) => n + t.plan.devDepsPinned.length, 0);

  // Catalog entries are root-global: the effective difference after accumulation (deduplicated, maximum).
  const catalogRows: Row[] = catalogChanges.map((ch) =>
    ch.from === undefined
      ? { state: 'missing', label: catalogLabel(ch), detail: `missing → ${ch.to}`, cmd: 'udx sync' }
      : {
          state: 'behind',
          label: catalogLabel(ch),
          detail: `${ch.from} → ${ch.to}`,
          cmd: 'udx sync'
        }
  );

  // "In sync" = canonical scripts/devDeps of the root tier (excluding declined ones) that appear in NO
  // plan list — counted directly rather than arithmetically, so no future capability dep without a
  // canonical counterpart silently miscounts. (Svelte package deps count as action items, not in this root counter.)
  const plannedScripts = new Set([...plan.scriptsToAdd, ...plan.scriptsDrift].map((ch) => ch.name));
  const plannedDeps = new Set(
    [
      ...plan.devDepsToAdd,
      ...plan.devDepsDrift,
      ...plan.devDepsPinned,
      ...plan.devDepsToCatalog // otherwise a dep switched to catalog: would count twice (as switch + "in sync")
    ].map((ch) => ch.name)
  );
  const inSync =
    Object.keys(canonicalScripts(ctx, rootTier)).filter(
      (n) => !declined.scripts.has(n) && !plannedScripts.has(n)
    ).length +
    Object.keys(canonicalDevDeps(ctx, rootTier)).filter(
      (n) => !skipDeps.has(n) && !plannedDeps.has(n)
    ).length;
  if (inSync > 0)
    pkg.push({ state: 'sync', label: `${inSync} more`, detail: 'scripts & devDeps in sync' });

  const bunfig = abs(ctx.cwd, 'bunfig.toml');
  const hasRegistry = exists(bunfig) && readText(bunfig).includes(URBICON_REGISTRY);
  const registry: Row[] = [
    hasRegistry
      ? { state: 'sync', label: 'bunfig.toml', detail: '@urbicon registry configured' }
      : {
          state: 'missing',
          label: 'bunfig.toml',
          detail: '@urbicon registry missing',
          cmd: 'udx sync'
        }
  ];

  // Actively offer self-managed configs: adopt them or keep your own.
  const wiringRows: Row[] = wiring
    .filter((w) => w.status === 'self-managed')
    .map((w) => ({
      state: 'unwired' as const,
      label: w.consuming,
      detail: `${w.dep} not wired`,
      cmd: `udx sync --only ${w.id} --force`
    }));

  return {
    ctx,
    held,
    sections: [
      { title: 'Building blocks', rows: blocks },
      { title: 'Files', rows: files },
      { title: 'package.json', rows: pkg },
      { title: 'Catalog', rows: catalogRows },
      { title: 'Wiring', rows: wiringRows },
      { title: 'Registry', rows: registry }
    ]
  };
}

function renderSection(section: Section): void {
  if (section.rows.length === 0) return;
  log.plain();
  log.step(section.title);
  const width = Math.min(32, Math.max(...section.rows.map((r) => r.label.length)));
  for (const r of section.rows) {
    const label = r.label.padEnd(width);
    const tail = r.cmd ? `${r.detail}  ${c.gray(`→ ${r.cmd}`)}` : c.gray(r.detail);
    log.info(`${GLYPH[r.state]} ${label}  ${tail}`);
  }
}

/**
 * Read-only overview: what the project has, what udx prescribes, what a `sync` changes and how.
 * Shares the engines with init/sync/doctor; `doctor` remains the CI variant (exit codes).
 */
export function runStatus(flags: StatusFlags): number {
  const { ctx, sections, held } = buildReport(flags);

  if (flags.json) {
    log.plain(JSON.stringify({ project: ctx.projectName, svelte: ctx.svelte, sections }, null, 2));
    return 0;
  }

  log.title(`udx status — ${ctx.projectName}${ctx.svelte ? c.gray(' (svelte)') : ''}`);
  for (const s of sections) renderSection(s);

  log.plain();
  log.info(
    c.gray(
      'Legend  ✓ in sync · ↑ sync bumps · + missing · ✎ locally modified (force/-i) · ⊙ pinned · ⊘ block off · ~ own config'
    )
  );
  const all = sections.flatMap((s) => s.rows);
  const raise = all.filter((r) => r.state === 'behind' || r.state === 'missing').length;
  const force = all.filter((r) => r.state === 'customized').length;
  const unwired = all.filter((r) => r.state === 'unwired').length;
  const parts: string[] = [];
  if (raise > 0) parts.push(`${raise}× ${c.cyan('udx sync')}`);
  if (force > 0) parts.push(`${force}× needs ${c.yellow('--force/-i')}`);
  if (held > 0) parts.push(`${held}× ${c.gray('pinned')}`);
  if (unwired > 0) parts.push(`${unwired}× ${c.gray('own config')}`);
  log.info(parts.length > 0 ? parts.join(' · ') : c.green('everything in sync.'));
  return 0;
}
