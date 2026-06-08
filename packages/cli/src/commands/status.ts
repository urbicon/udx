import { type ApplyOptions, applyFiles, type FileResult, URBICON_REGISTRY } from '../lib/apply.ts';
import { declinedSets, resolveCapabilities } from '../lib/capabilities.ts';
import { c } from '../lib/colors.ts';
import { detectContext, type ProjectContext } from '../lib/detect.ts';
import { abs, exists, readText } from '../lib/fs.ts';
import { log } from '../lib/log.ts';
import { readManifest } from '../lib/manifest.ts';
import { canonicalDevDeps, canonicalScripts, computePkgPlan } from '../lib/pkg.ts';
import { isTypeScriptPackage, resolveWorkspaces } from '../lib/workspace.ts';

export interface StatusFlags {
  cwd: string;
  svelte: boolean | undefined;
  /** Strukturierte Ausgabe für Tooling statt der Tabelle. */
  json: boolean;
}

/** Klassifikation eines verwalteten Dings — bestimmt Glyphe, Farbe und die empfohlene Aktion. */
type State = 'sync' | 'behind' | 'missing' | 'customized' | 'pinned' | 'declined';

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
  declined: c.gray('⊘')
};

/** Übersetzt ein applyFiles-Dry-Ergebnis in eine Status-Zeile (declined-Dateien → null, stehen unter Bausteine). */
function fileRow(r: FileResult, prefix = ''): Row | null {
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
      // 'skipped': abgewählt (→ unter Bausteine) vs. create-only vorhanden (→ als ok zeigen).
      if (r.note?.startsWith('abgewählt')) return null;
      return { state: 'sync', label, detail: 'vorhanden' };
  }
}

/** Sammelt alle Dateizeilen (Root + im Monorepo je TS-Paket package-scoped). */
function fileRows(ctx: ProjectContext, declinedFiles: ReadonlyMap<string, string>): Row[] {
  const dry: ApplyOptions = { mode: 'sync', dryRun: true, force: false };
  const workspaces = resolveWorkspaces(ctx.cwd, ctx.pkg);
  const isMonorepo = workspaces.length > 0;
  const rows: Row[] = [];

  const rootOpts = isMonorepo ? { ...dry, scope: 'root' as const } : dry;
  for (const r of applyFiles(ctx.cwd, ctx, rootOpts, readManifest(ctx.cwd), declinedFiles)) {
    const row = fileRow(r);
    if (row) rows.push(row);
  }
  if (isMonorepo) {
    for (const ws of workspaces) {
      const pkgCtx = detectContext(abs(ctx.cwd, ws), ctx.svelte);
      if (!isTypeScriptPackage(pkgCtx.cwd, pkgCtx.pkg)) continue;
      const res = applyFiles(
        pkgCtx.cwd,
        pkgCtx,
        { ...dry, scope: 'package' },
        readManifest(ctx.cwd),
        new Map()
      );
      for (const r of res) {
        const row = fileRow(r, `${ws}/`);
        if (row) rows.push(row);
      }
    }
  }
  return rows;
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

  const bausteine: Row[] = capStates.map((s) =>
    s.declined
      ? {
          state: 'declined' as const,
          label: s.cap.label,
          detail: `abgewählt (${s.reason})`,
          cmd: `udx adopt ${s.cap.id}`
        }
      : { state: 'sync' as const, label: s.cap.label, detail: 'aktiv' }
  );

  const dateien = fileRows(ctx, declined.files);

  // package.json: nur das Handlungsrelevante als Zeile, der Rest als „in sync"-Zähler.
  const plan = computePkgPlan(ctx, {
    skip: { scripts: declined.scripts, devDeps: declined.devDeps },
    pinned
  });
  const pkg: Row[] = [];
  for (const ch of plan.devDepsToAdd)
    pkg.push({ state: 'missing', label: ch.name, detail: `fehlt → ${ch.to}`, cmd: 'udx sync' });
  for (const ch of plan.devDepsDrift)
    pkg.push({ state: 'behind', label: ch.name, detail: `${ch.from} → ${ch.to}`, cmd: 'udx sync' });
  for (const ch of plan.scriptsToAdd)
    pkg.push({ state: 'missing', label: `${ch.name} (script)`, detail: 'fehlt', cmd: 'udx sync' });
  for (const ch of plan.scriptsDrift)
    pkg.push({
      state: 'customized',
      label: `${ch.name} (script)`,
      detail: 'angepasst',
      cmd: 'udx sync --force'
    });
  for (const ch of plan.devDepsPinned)
    pkg.push({
      state: 'pinned',
      label: ch.name,
      detail: `gehalten bei ${ch.from ?? '(nicht installiert)'}`,
      cmd: `udx unpin ${ch.name}`
    });

  const totalCanon =
    Object.keys(canonicalScripts(ctx)).length -
    declined.scripts.size +
    (Object.keys(canonicalDevDeps(ctx)).length - declined.devDeps.size);
  const actionable =
    plan.scriptsToAdd.length +
    plan.scriptsDrift.length +
    plan.devDepsToAdd.length +
    plan.devDepsDrift.length +
    plan.devDepsPinned.length;
  const inSync = Math.max(0, totalCanon - actionable);
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

  return {
    ctx,
    held: plan.devDepsPinned.length,
    sections: [
      { title: 'Bausteine', rows: bausteine },
      { title: 'Dateien', rows: dateien },
      { title: 'package.json', rows: pkg },
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
      'Legende  ✓ in sync · ↑ sync zieht hoch · + fehlt · ✎ lokal geändert (force/-i) · ⊙ gehalten · ⊘ Baustein aus'
    )
  );
  const all = sections.flatMap((s) => s.rows);
  const raise = all.filter((r) => r.state === 'behind' || r.state === 'missing').length;
  const force = all.filter((r) => r.state === 'customized').length;
  const parts: string[] = [];
  if (raise > 0) parts.push(`${raise}× ${c.cyan('udx sync')}`);
  if (force > 0) parts.push(`${force}× braucht ${c.yellow('--force/-i')}`);
  if (held > 0) parts.push(`${held}× ${c.gray('gehalten')}`);
  log.info(parts.length > 0 ? parts.join(' · ') : c.green('alles in sync.'));
  return 0;
}
