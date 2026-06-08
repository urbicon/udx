import { basename } from 'node:path';
import { type ApplyOptions, applyFiles, ensureBunfig, type FileResult } from '../lib/apply.ts';
import {
  type CapabilityState,
  type DeclinedSets,
  declinedSets,
  resolveCapabilities,
  resolveSelection,
  type Selection
} from '../lib/capabilities.ts';
import { c } from '../lib/colors.ts';
import { detectContext, type PackageJson, type ProjectContext } from '../lib/detect.ts';
import { formatDiff } from '../lib/diff.ts';
import { abs, exists, readJson, readText, writeJson } from '../lib/fs.ts';
import { log, reportAction } from '../lib/log.ts';
import { MANIFEST_FILE, type Manifest, readManifest, writeManifest } from '../lib/manifest.ts';
import { computePkgPlan, mutatePkg, type PkgSet } from '../lib/pkg.ts';
import { CLI_VERSION } from '../lib/versions.ts';
import { isTypeScriptPackage, resolveWorkspaces } from '../lib/workspace.ts';
import { FILE_TEMPLATES } from '../templates/index.ts';

export interface HarnessFlags {
  cwd: string;
  dryRun: boolean;
  force: boolean;
  svelte: boolean | undefined;
  /** Bei Drift den Unterschied lokal → Template anzeigen. */
  diff: boolean;
  /** Nur diese Bausteine (Capability- oder Datei-Ids) verarbeiten; leer = alle. */
  only: string[];
  /** Bei Konflikten pro Datei interaktiv entscheiden (braucht ein TTY). */
  interactive: boolean;
}

/** Persistiert frische Auto-Abwahlen ins Manifest (globaler Fakt, auch unter `--only`). */
function persistDeclines(states: CapabilityState[], manifest: Manifest): void {
  for (const s of states) {
    if (s.declined && s.fresh) manifest.declined[s.cap.id] = s.reason;
  }
}

/** Zeigt abgewählte Bausteine unaufdringlich an (eine Zeile je Baustein + Hinweis). */
function reportCapabilities(states: CapabilityState[]): void {
  const declined = states.filter((s) => s.declined);
  if (declined.length === 0) return;

  log.plain();
  log.step('Bausteine');
  for (const s of declined) {
    const detail = s.fresh
      ? `${s.reason} erkannt — übersprungen, gemerkt`
      : `abgewählt (${s.reason})`;
    log.skip(`${s.cap.label}: ${detail}`);
  }
  log.info(
    c.gray('Aktivieren mit `udx add <id>` (z. B. git-hooks), abwählen mit `udx remove <id>`.')
  );
}

function ensurePackageJson(cwd: string, dryRun: boolean): void {
  const path = abs(cwd, 'package.json');
  if (exists(path)) return;
  log.warn('keine package.json gefunden — lege eine minimale an');
  if (dryRun) return;
  writeJson(path, {
    name: basename(cwd),
    version: '0.0.0',
    type: 'module',
    private: true,
    scripts: {}
  });
}

function patchPkg(
  ctx: ProjectContext,
  dryRun: boolean,
  force: boolean,
  declined: DeclinedSets,
  only: PkgSet | undefined,
  pinned: ReadonlySet<string>
): void {
  const plan = computePkgPlan(ctx, {
    skip: { scripts: declined.scripts, devDeps: declined.devDeps },
    pinned,
    ...(only ? { only } : {})
  });
  // Auto = wird ohne --force angewandt (fehlende ergänzen + sicheres Anheben hinter dem Pin).
  const auto = plan.scriptsToAdd.length + plan.devDepsToAdd.length + plan.devDepsDrift.length;
  const scriptDrift = plan.scriptsDrift.length;
  const held = plan.devDepsPinned.length;

  log.plain();
  log.step('package.json');

  if (auto === 0 && scriptDrift === 0 && held === 0) {
    log.skip('Scripts & devDeps vollständig');
    return;
  }

  for (const ch of plan.scriptsToAdd) log.info(`${c.green('+ script')} ${ch.name}`);
  for (const ch of plan.devDepsToAdd) log.info(`${c.green('+ devDep')} ${ch.name}@${ch.to}`);
  // Versions-Drift wird sicher angehoben (nie Downgrade) — kein --force nötig.
  for (const ch of plan.devDepsDrift) {
    log.info(`${c.cyan('↑ devDep')} ${ch.name} ${ch.from} → ${ch.to}`);
  }
  for (const ch of plan.devDepsPinned) {
    const at = ch.from ?? '(nicht installiert)';
    log.skip(`devDep ${ch.name} gehalten bei ${at} (lösen: udx unpin ${ch.name})`);
  }
  for (const ch of plan.scriptsDrift) {
    if (force) log.info(`${c.yellow('~ script')} ${ch.name}`);
    else log.warn(`script ${ch.name} weicht ab (bleibt; --force überschreibt)`);
  }

  if (dryRun) return;
  // Nichts tatsächlich Schreibbares (z. B. nur gehaltene Deps gemeldet) → kein Datei-Roundtrip.
  if (auto === 0 && !(force && scriptDrift > 0)) return;
  const pkg = readJson<PackageJson>(abs(ctx.cwd, 'package.json'));
  if (mutatePkg(pkg, plan, force)) writeJson(abs(ctx.cwd, 'package.json'), pkg);
}

function printFooter(
  mode: 'init' | 'sync',
  ctx: ProjectContext,
  flags: HarnessFlags,
  results: FileResult[],
  declined: DeclinedSets
): void {
  const conflicts = results.filter((r) => r.action === 'conflict');
  if (conflicts.length > 0) {
    log.plain();
    log.warn(
      `${conflicts.length} lokal geänderte Datei(en) geschützt: ${conflicts
        .map((r) => r.dest)
        .join(', ')}`
    );
    log.info(c.gray('Übernehmen mit `--force`.'));
  }

  log.plain();
  if (flags.dryRun) {
    log.info(c.gray('Dry-Run beendet — ohne --dry-run erneut ausführen, um zu schreiben.'));
    return;
  }
  if (mode === 'init') {
    const hooks = declined.scripts.has('prepare') ? '' : ' + Git-Hooks via prepare-Script';
    log.title('Nächste Schritte');
    log.info(
      `1. ${c.cyan('export CODEBERG_TOKEN=…')} ${c.gray('(Zugriff auf die @urbicon-Registry)')}`
    );
    log.info(`2. ${c.cyan('bun install')} ${c.gray(`(Deps${hooks})`)}`);
    log.info(`3. Scopes in ${c.cyan('commitlint.config.mjs')} ergänzen`);
    if (ctx.svelte)
      log.info(
        `4. ${c.cyan('bunx svelte-kit sync')} ${c.gray('(erzeugt .svelte-kit/tsconfig.json)')}`
      );
  } else {
    log.ok('Sync abgeschlossen.');
    log.info(c.gray('Bei neuen devDeps/Scripts anschließend: bun install'));
  }
}

/**
 * Geht Konflikt-Dateien interaktiv durch: [u]pdate übernimmt das Template (gezieltes
 * Force-Write nur dieser Datei), [s]kip lässt die lokale Fassung, [d]iff zeigt den
 * Unterschied und fragt erneut. Leere Eingabe/EOF ⇒ konservativ skippen. Braucht ein TTY.
 */
function runInteractive(
  cwd: string,
  ctx: ProjectContext,
  mode: 'init' | 'sync',
  manifest: Manifest,
  conflicts: FileResult[]
): void {
  if (conflicts.length === 0) return;
  if (!process.stdin.isTTY) {
    log.plain();
    log.warn('--interactive braucht ein TTY — Konflikte unverändert gelassen.');
    return;
  }
  log.plain();
  log.step('Interaktiv');
  for (const cf of conflicts) {
    if (!cf.id) continue;
    let decision: 'u' | 's' | null = null;
    while (decision === null) {
      const raw = prompt(`  ${cf.dest} — [u]pdate / [s]kip / [d]iff?`);
      if (raw === null) {
        decision = 's'; // EOF ⇒ nichts überschreiben
        break;
      }
      const ans = raw.trim().toLowerCase();
      if (ans === 'u' || ans === 'update') decision = 'u';
      else if (ans === '' || ans === 's' || ans === 'skip') decision = 's';
      else if (ans === 'd' || ans === 'diff') {
        const tpl = FILE_TEMPLATES.find((t) => t.id === cf.id);
        if (tpl)
          log.block(formatDiff(readText(abs(cwd, cf.dest)), tpl.render(ctx), { color: true }));
      }
    }
    if (decision === 'u') {
      // Gezieltes Force-Write nur dieser Datei; leere declined-Map, da der Nutzer
      // die Übernahme explizit gewählt hat (überstimmt eine etwaige Abwahl).
      applyFiles(
        cwd,
        ctx,
        { mode, dryRun: false, force: true },
        manifest,
        new Map(),
        new Set([cf.id])
      );
      log.ok(`${cf.dest} übernommen`);
    } else {
      log.skip(`${cf.dest} unverändert gelassen`);
    }
  }
}

/**
 * `manifestOverride` lässt einen Aufrufer ein bereits im Speicher mutiertes Manifest durchreichen
 * (statt es frisch von der Platte zu lesen). `udx add` nutzt das: die Aufnahme eines Bausteins liegt
 * dann auch im Dry-Run vor, sonst übersprünge ein gezielter `sync --only` einen auto-abgewählten
 * Baustein. Das Manifest wird am Ende wie gewohnt persistiert (außer im Dry-Run).
 */
export function runHarness(
  mode: 'init' | 'sync',
  flags: HarnessFlags,
  manifestOverride?: Manifest
): number {
  ensurePackageJson(flags.cwd, flags.dryRun);
  const ctx = detectContext(flags.cwd, flags.svelte);
  const manifest = manifestOverride ?? readManifest(ctx.cwd);
  const capStates = resolveCapabilities(ctx, manifest);
  const declined = declinedSets(capStates);

  // --only: Auswahl auf konkrete Bausteine auflösen (null = alle).
  const validFileIds = new Set(FILE_TEMPLATES.map((t) => t.id));
  const selection: Selection | null =
    flags.only.length > 0 ? resolveSelection(flags.only, validFileIds) : null;
  const onlyFiles = selection ? selection.files : null;
  const onlyPkg: PkgSet | undefined = selection
    ? { scripts: selection.scripts, devDeps: selection.devDeps }
    : undefined;

  // Monorepo: package-scoped Bausteine (tsconfig) laufen je Paket, nicht im Root.
  const workspaces = resolveWorkspaces(ctx.cwd, ctx.pkg);
  const isMonorepo = workspaces.length > 0;
  const baseOpts: ApplyOptions = {
    mode,
    dryRun: flags.dryRun,
    force: flags.force,
    diff: flags.diff
  };

  const label = mode === 'init' ? 'udx init' : 'udx sync';
  log.title(`${label} — ${ctx.projectName}${ctx.svelte ? c.gray(' (svelte)') : ''}`);
  if (flags.dryRun) log.info(`${c.yellow('Dry-Run')} — es wird nichts geschrieben`);
  if (isMonorepo) log.info(c.gray(`Monorepo — ${workspaces.length} Paket(e)`));
  if (selection && selection.unknown.length > 0)
    log.warn(`--only: unbekannt, ignoriert: ${selection.unknown.join(', ')}`);

  log.plain();
  log.step('Dateien');
  const results: FileResult[] = applyFiles(
    ctx.cwd,
    ctx,
    isMonorepo ? { ...baseOpts, scope: 'root' } : baseOpts,
    manifest,
    declined.files,
    onlyFiles
  );
  if (!selection) results.push(ensureBunfig(ctx.cwd, flags.dryRun));
  for (const r of results) {
    reportAction(r.action, r.dest, r.note);
    if (r.diff) log.block(r.diff);
  }
  // Gesamtsicht über Root + Pakete (Leertreffer-Warnung & Konflikt-Footer).
  const allResults: FileResult[] = [...results];

  // Pro Paket die package-scoped Bausteine (Svelte je Paket erkannt). Asset-Pakete ohne
  // TS-Code werden übersprungen, damit nicht überall unnötige tsconfigs entstehen.
  if (isMonorepo) {
    const tsPkgs = workspaces
      .map((ws) => ({ ws, pkgCtx: detectContext(abs(ctx.cwd, ws), flags.svelte) }))
      .filter(({ pkgCtx }) => isTypeScriptPackage(pkgCtx.cwd, pkgCtx.pkg));
    if (tsPkgs.length > 0) {
      log.plain();
      log.step('Pakete');
      for (const { ws, pkgCtx } of tsPkgs) {
        const pkgResults = applyFiles(
          pkgCtx.cwd,
          pkgCtx,
          { ...baseOpts, scope: 'package' },
          manifest,
          new Map(),
          onlyFiles
        );
        for (const r of pkgResults) {
          reportAction(r.action, `${ws}/${r.dest}`, r.note);
          if (r.diff) log.block(r.diff);
          allResults.push({ ...r, dest: `${ws}/${r.dest}` });
        }
      }
    }
  }
  if (selection && allResults.length === 0)
    log.warn('--only: keine passende Datei angewandt (ggf. greift die applies-Bedingung nicht).');

  // Auto-Abwahlen nur ohne --only behandeln: --only ist chirurgisch (fasst nur die genannten
  // Bausteine an); die Abwahl ist deterministisch und wird vom nächsten vollen `sync` persistiert.
  // So entsteht keine stille Manifest-Mutation, die der unterdrückte Report nicht erklären würde.
  if (!selection) {
    if (!flags.dryRun) persistDeclines(capStates, manifest);
    reportCapabilities(capStates);
  }

  patchPkg(
    ctx,
    flags.dryRun,
    flags.force,
    declined,
    onlyPkg,
    new Set(Object.keys(manifest.pinned))
  );

  // Interaktiv nur Root-Konflikte: package-scoped Bausteine sind create-only (s. Guard in
  // templates/index.ts) und können daher nicht in Konflikt geraten.
  if (flags.interactive && !flags.dryRun) {
    runInteractive(
      ctx.cwd,
      ctx,
      mode,
      manifest,
      results.filter((r) => r.action === 'conflict')
    );
  }

  manifest.harness = CLI_VERSION;
  if (writeManifest(ctx.cwd, manifest, flags.dryRun)) {
    log.plain();
    log.skip(`Manifest ${MANIFEST_FILE} ${flags.dryRun ? 'würde aktualisiert' : 'aktualisiert'}`);
  }

  printFooter(mode, ctx, flags, allResults, declined);
  return 0;
}
