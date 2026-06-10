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

export interface StatusFlags {
  cwd: string;
  svelte: boolean | undefined;
  /** Strukturierte Ausgabe für Tooling statt der Tabelle. */
  json: boolean;
}

/** Klassifikation eines verwalteten Dings — bestimmt Glyphe, Farbe und die empfohlene Aktion. */
type State = 'sync' | 'behind' | 'missing' | 'customized' | 'pinned' | 'declined' | 'unwired';

interface Row {
  state: State;
  label: string;
  detail: string;
  /** Befehl, der diese Zeile auflöst (in der Tabelle hinter dem Pfeil). */
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

/** Übersetzt ein applyFiles-Dry-Ergebnis in eine Status-Zeile (declined-Dateien filtert `fileRows` vorab). */
function fileRow(r: FileResult, prefix = ''): Row {
  const label = `${prefix}${r.dest}`;
  switch (r.action) {
    case 'unchanged':
      return { state: 'sync', label, detail: 'aktuell' };
    case 'created':
    case 'would-create':
      return { state: 'missing', label, detail: 'fehlt', cmd: 'udx sync' };
    case 'updated':
    case 'would-update':
      return { state: 'behind', label, detail: 'veraltet', cmd: 'udx sync' };
    case 'conflict':
      return { state: 'customized', label, detail: 'lokal geändert', cmd: 'udx sync -i' };
    default:
      // 'skipped' erreicht hier nur create-only-vorhanden — declined-Dateien sind schon raus.
      return { state: 'sync', label, detail: 'vorhanden' };
  }
}

/** Sammelt alle Dateizeilen (Root + im Monorepo je TS-Paket package-scoped). */
function fileRows(
  ctx: ProjectContext,
  declinedFiles: ReadonlyMap<string, string>,
  manifest: Manifest
): Row[] {
  const dry: ApplyOptions = { mode: 'sync', dryRun: true, force: false };
  const workspaces = resolveWorkspaces(ctx.cwd, ctx.pkg);
  const isMonorepo = workspaces.length > 0;
  const rows: Row[] = [];

  // Declined-Dateien über ihre id rausfiltern (statt am Hinweistext) — sie stehen unter Bausteine.
  const rootOpts = isMonorepo ? { ...dry, scope: 'root' as const } : dry;
  for (const r of applyFiles(ctx.cwd, ctx, rootOpts, manifest, declinedFiles)) {
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

/** package.json-Plan → Status-Zeilen (Prefix = Paketpfad im Monorepo). */
function pkgRows(plan: PkgPlan, prefix = ''): Row[] {
  const rows: Row[] = [];
  for (const ch of plan.devDepsToAdd)
    rows.push({
      state: 'missing',
      label: `${prefix}${ch.name}`,
      detail: `fehlt → ${ch.to}`,
      cmd: 'udx sync'
    });
  for (const ch of plan.devDepsDrift)
    rows.push({
      state: 'behind',
      label: `${prefix}${ch.name}`,
      detail: `${ch.from} → ${ch.to}`,
      cmd: 'udx sync'
    });
  // D9: literale devDep wird auf den Catalog-Verweis umgestellt.
  for (const ch of plan.devDepsToCatalog)
    rows.push({
      state: 'behind',
      label: `${prefix}${ch.name}`,
      detail: `${ch.from} → ${ch.to}`,
      cmd: 'udx sync'
    });
  // Umbenannter Tool-Dep: alter Name entfällt zugunsten des Nachfolgers.
  for (const ch of plan.devDepsToRemove)
    rows.push({
      state: 'behind',
      label: `${prefix}${ch.name}`,
      detail: `entfällt (ersetzt durch ${ch.to})`,
      cmd: 'udx sync'
    });
  for (const ch of plan.scriptsToAdd)
    rows.push({
      state: 'missing',
      label: `${prefix}${ch.name} (script)`,
      detail: 'fehlt',
      cmd: 'udx sync'
    });
  for (const ch of plan.scriptsDrift)
    rows.push({
      state: 'customized',
      label: `${prefix}${ch.name} (script)`,
      detail: 'angepasst',
      cmd: 'udx sync --force'
    });
  for (const ch of plan.devDepsPinned)
    rows.push({
      state: 'pinned',
      label: `${prefix}${ch.name}`,
      detail: `gehalten bei ${ch.from ?? '(nicht installiert)'}`,
      cmd: `udx unpin ${ch.name}`
    });
  return rows;
}

/** Label einer Catalog-Eintrags-Zeile (mit benanntem Catalog, falls nicht der Default). */
function catalogLabel(ch: CatalogChange): string {
  return ch.table ? `${ch.name} (catalogs.${ch.table})` : ch.name;
}

/** Erzeugt den vollständigen Statusbericht — wiederverwendet dieselben Engines wie init/sync/doctor. */
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

  // Verdrahtung: selbstverwaltete Configs ⇒ ihr @urbicon-Preset-Dep zählt nicht als Soll
  // (weder fehlend noch „in sync"), sondern erscheint unten als eigene Zeile.
  const wiring = detectWiring(ctx);
  const wiringSkip = wiringSkipDeps(wiring);
  const skipDeps = new Set([...declined.devDeps, ...wiringSkip]);

  const bausteine: Row[] = capStates.map((s) =>
    s.declined
      ? {
          state: 'declined' as const,
          label: s.cap.label,
          detail: `abgewählt (${s.reason})`,
          cmd: `udx add ${s.cap.id}`
        }
      : { state: 'sync' as const, label: s.cap.label, detail: 'aktiv' }
  );

  const dateien = fileRows(ctx, declined.files, manifest);

  // package.json: nur das Handlungsrelevante als Zeile, der Rest als „in sync"-Zähler. Monorepo: Root
  // trägt das root-Tier (svelte-Root = alles); jedes Svelte-Paket sein svelte-Tier (D9-C). Im
  // Catalog-Modus (D9-A) werden Tool-Versionen als catalog: geführt + die Einträge gepflegt.
  const view = resolveWorkspaceView(ctx, flags.svelte);
  const { rootTier } = view; // für den root-Tier-„in sync"-Zähler; catalog nutzt planWorkspace intern
  const skipFilter = { skip: { scripts: declined.scripts, devDeps: skipDeps }, pinned };

  // Mit Catalog-Akkumulation planen (wie der echte sync) — so meldet status exakt dessen Ergebnis.
  const { targets, catalogChanges } = planWorkspace(view, skipFilter);
  const plan = targets[0]?.plan as PkgPlan; // Root-Plan (immer vorhanden)
  const pkg: Row[] = targets.flatMap((t) => pkgRows(t.plan, t.ws ? `${t.ws}/` : ''));
  const held = targets.reduce((n, t) => n + t.plan.devDepsPinned.length, 0);

  // Catalog-Einträge sind Root-global: die effektive Differenz nach Akkumulation (dedupliziert, Maximum).
  const catalogRows: Row[] = catalogChanges.map((ch) =>
    ch.from === undefined
      ? { state: 'missing', label: catalogLabel(ch), detail: `fehlt → ${ch.to}`, cmd: 'udx sync' }
      : {
          state: 'behind',
          label: catalogLabel(ch),
          detail: `${ch.from} → ${ch.to}`,
          cmd: 'udx sync'
        }
  );

  // „In sync" = kanonische Scripts/devDeps des root-Tiers (ohne abgewählte), die in KEINER Plan-Liste
  // stehen — direkt gezählt statt arithmetisch, damit kein künftiges Capability-Dep ohne canonical-Pendant
  // still falsch zählt. (Svelte-Paket-Deps zählen als Handlungsbedarf, nicht in diesen Root-Zähler.)
  const plannedScripts = new Set([...plan.scriptsToAdd, ...plan.scriptsDrift].map((ch) => ch.name));
  const plannedDeps = new Set(
    [
      ...plan.devDepsToAdd,
      ...plan.devDepsDrift,
      ...plan.devDepsPinned,
      ...plan.devDepsToCatalog // sonst zählt ein auf catalog: umgestellter Dep doppelt (als Switch + „in sync")
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
    pkg.push({ state: 'sync', label: `${inSync} weitere`, detail: 'Scripts & devDeps in sync' });

  const bunfig = abs(ctx.cwd, 'bunfig.toml');
  const hasRegistry = exists(bunfig) && readText(bunfig).includes(URBICON_REGISTRY);
  const registry: Row[] = [
    hasRegistry
      ? { state: 'sync', label: 'bunfig.toml', detail: '@urbicon-Registry konfiguriert' }
      : {
          state: 'missing',
          label: 'bunfig.toml',
          detail: '@urbicon-Registry fehlt',
          cmd: 'udx sync'
        }
  ];

  // Selbstverwaltete Configs aktiv anbieten: übernehmen oder die eigene behalten.
  const verdrahtung: Row[] = wiring
    .filter((w) => w.status === 'self-managed')
    .map((w) => ({
      state: 'unwired' as const,
      label: w.consuming,
      detail: `${w.dep} nicht verdrahtet`,
      cmd: `udx sync --only ${w.id} --force`
    }));

  return {
    ctx,
    held,
    sections: [
      { title: 'Bausteine', rows: bausteine },
      { title: 'Dateien', rows: dateien },
      { title: 'package.json', rows: pkg },
      { title: 'Catalog', rows: catalogRows },
      { title: 'Verdrahtung', rows: verdrahtung },
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
 * Read-only-Gesamtsicht: was hat das Projekt, was schreibt udx vor, was ändert ein `sync` und wie.
 * Teilt die Engines mit init/sync/doctor; `doctor` bleibt die CI-Variante (Exit-Codes).
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
      'Legende  ✓ in sync · ↑ sync zieht hoch · + fehlt · ✎ lokal geändert (force/-i) · ⊙ gehalten · ⊘ Baustein aus · ~ eigene Config'
    )
  );
  const all = sections.flatMap((s) => s.rows);
  const raise = all.filter((r) => r.state === 'behind' || r.state === 'missing').length;
  const force = all.filter((r) => r.state === 'customized').length;
  const unwired = all.filter((r) => r.state === 'unwired').length;
  const parts: string[] = [];
  if (raise > 0) parts.push(`${raise}× ${c.cyan('udx sync')}`);
  if (force > 0) parts.push(`${force}× braucht ${c.yellow('--force/-i')}`);
  if (held > 0) parts.push(`${held}× ${c.gray('gehalten')}`);
  if (unwired > 0) parts.push(`${unwired}× ${c.gray('eigene Config')}`);
  log.info(parts.length > 0 ? parts.join(' · ') : c.green('alles in sync.'));
  return 0;
}
