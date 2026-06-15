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
import type { CatalogTables } from '../lib/catalog.ts';
import { c } from '../lib/colors.ts';
import { detectContext, type PackageJson, type ProjectContext } from '../lib/detect.ts';
import { formatDiff } from '../lib/diff.ts';
import { abs, exists, readText, writeJson } from '../lib/fs.ts';
import { log, reportAction } from '../lib/log.ts';
import { MANIFEST_FILE, type Manifest, readManifest, writeManifest } from '../lib/manifest.ts';
import {
  applyCatalogEntries,
  computePkgPlan,
  type DepTier,
  mutatePkg,
  type PkgSet,
  wireCatalog
} from '../lib/pkg.ts';
import { resolveWorkspaceView } from '../lib/targets.ts';
import { CLI_VERSION } from '../lib/versions.ts';
import { detectWiring, type WiringState, wiringSkipDeps } from '../lib/wiring.ts';
import { FILE_TEMPLATES, type RenderCtx } from '../templates/index.ts';

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
  /** Nach erfolgreichem Lauf `bun install` ausführen (opt-in; der Footer bietet es sonst an). */
  install: boolean;
}

export interface InstallPlan {
  /** `bun install` tatsächlich ausführen. */
  run: boolean;
  /** `--install` im Footer anbieten (Änderungen vorhanden, aber nicht angefordert). */
  offer: boolean;
}

/**
 * Entscheidet rein, ob nach dem Lauf `bun install` läuft oder nur angeboten wird. Nur sinnvoll,
 * wenn die package.json installierbare Änderungen erhielt (neue/angehobene devDeps oder Scripts);
 * im Dry-Run passiert nichts.
 */
export function installPlan(
  flags: { install: boolean; dryRun: boolean },
  pkgChanged: boolean
): InstallPlan {
  if (flags.dryRun || !pkgChanged) return { run: false, offer: false };
  return flags.install ? { run: true, offer: false } : { run: false, offer: true };
}

/** Führt `bun install` im Projekt aus (Bun-nativ, Ausgabe durchgereicht). Gibt den Erfolg zurück. */
function installDeps(cwd: string): boolean {
  log.plain();
  log.step('bun install');
  let success = false;
  try {
    ({ success } = Bun.spawnSync(['bun', 'install'], {
      cwd,
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit'
    }));
  } catch (err) {
    // Bun.spawnSync wirft (statt success:false), wenn `bun` nicht im $PATH liegt.
    log.err(
      `bun install ließ sich nicht starten: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
  // success:false auch, wenn nur ein Lifecycle-Script (z. B. prepare) scheiterte, die Deps aber
  // installiert wurden — daher auf die durchgereichte Ausgabe verweisen statt pauschal „fehlgeschlagen".
  if (success) log.ok('Abhängigkeiten installiert.');
  else log.err('bun install nicht sauber durchgelaufen (Details oben) — bitte prüfen.');
  return success;
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

/** Meldet selbstverwaltete Configs neutral und bietet das Übernehmen der udx-Vorlage an (D9). */
function reportWiring(wiring: WiringState[]): void {
  const self = wiring.filter((w) => w.status === 'self-managed');
  if (self.length === 0) return;

  log.plain();
  log.step('Verdrahtung');
  for (const w of self) {
    log.skip(
      `${w.consuming}: ${w.dep} nicht verdrahtet — übernehmen mit \`udx sync --only ${w.id} --force\``
    );
  }
  log.info(c.gray('… oder die eigene Config behalten (nichts tun).'));
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

/** Gemeinsame Eingaben für alle `patchPkg`-Aufrufe eines Laufs (Root + Svelte-Pakete). */
interface PatchShared {
  dryRun: boolean;
  force: boolean;
  declined: DeclinedSets;
  only: PkgSet | undefined;
  pinned: ReadonlySet<string>;
  /** Selbstverwaltete @urbicon-Preset-Deps (Verdrahtung) — nicht ergänzen. */
  wiringSkip: ReadonlySet<string>;
  /**
   * Mutables Catalog-Arbeitsobjekt des Consumers (aus dem Root-pkg gelesen); `null` ⇒ literal-Modus
   * (D9-A). Die Einträge aller Patches sammeln sich hier (Akkumulation über Pakete) und werden vom
   * Caller per `wireCatalog` einmal ins Root-pkg verdrahtet.
   */
  catalog: CatalogTables | null;
}

interface PatchResult {
  /** Neue/angehobene Deps, Scripts oder Catalog-Änderungen → `bun install` sinnvoll. */
  installable: boolean;
  /** Das Ziel-pkg (Root oder Sub-Paket) wurde mutiert → vom Caller schreiben. */
  targetChanged: boolean;
  /** Das geteilte Root-pkg (Catalog-Einträge) wurde mutiert → vom Caller einmal schreiben. */
  rootCatalogChanged: boolean;
}

const NO_PATCH: PatchResult = {
  installable: false,
  targetChanged: false,
  rootCatalogChanged: false
};

/**
 * Plant die package.json-Änderungen eines Pakets und wendet sie **in-memory** an: Scripts/devDeps am
 * `targetPkg`, Catalog-Einträge am geteilten `s.catalog`-Arbeitsobjekt (Bun-Catalogs leben nur in der
 * Root). Schreibt NICHT — der Caller persistiert `targetPkg` je Paket und verdrahtet den Catalog per
 * `wireCatalog` einmal ins Root-pkg, damit ein `catalog:`-devDep nie ohne seinen Eintrag entsteht.
 * `tier`/`label` steuern Platzierung und Überschrift.
 */
function patchPkg(
  ctx: ProjectContext,
  targetPkg: PackageJson,
  s: PatchShared,
  tier?: DepTier,
  label = 'package.json'
): PatchResult {
  const plan = computePkgPlan(
    ctx,
    {
      skip: {
        scripts: s.declined.scripts,
        devDeps: new Set([...s.declined.devDeps, ...s.wiringSkip])
      },
      pinned: s.pinned,
      ...(s.only ? { only: s.only } : {})
    },
    tier,
    s.catalog
  );
  // Auto = wird ohne --force angewandt (fehlende ergänzen, sicheres Anheben, Catalog-Pflege + Switch).
  const catalogChanges =
    plan.catalogEntriesToAdd.length +
    plan.catalogEntriesDrift.length +
    plan.devDepsToCatalog.length;
  const auto =
    plan.scriptsToAdd.length +
    plan.devDepsToAdd.length +
    plan.devDepsDrift.length +
    plan.devDepsToRemove.length +
    catalogChanges;
  const scriptDrift = plan.scriptsDrift.length;
  const held = plan.devDepsPinned.length;

  log.plain();
  log.step(label);

  if (auto === 0 && scriptDrift === 0 && held === 0) {
    log.skip('Scripts & devDeps vollständig');
    return NO_PATCH;
  }

  for (const ch of plan.scriptsToAdd) log.info(`${c.green('+ script')} ${ch.name}`);
  for (const ch of plan.devDepsToAdd) log.info(`${c.green('+ devDep')} ${ch.name}@${ch.to}`);
  // Versions-Drift wird sicher angehoben (nie Downgrade) — kein --force nötig.
  for (const ch of plan.devDepsDrift) {
    log.info(`${c.cyan('↑ devDep')} ${ch.name} ${ch.from} → ${ch.to}`);
  }
  // Umbenannter Tool-Dep: alter Name entfällt zugunsten des Nachfolgers.
  for (const ch of plan.devDepsToRemove) {
    log.info(`${c.red('- devDep')} ${ch.name} ${c.gray(`(ersetzt durch ${ch.to})`)}`);
  }
  // Catalog-Modus (D9): devDep auf catalog: umstellen, Eintrag anlegen/anheben.
  for (const ch of plan.devDepsToCatalog) {
    log.info(`${c.cyan('~ devDep')} ${ch.name} ${ch.from} → ${ch.to}`);
  }
  for (const ch of plan.catalogEntriesToAdd) {
    const where = ch.table ? c.gray(` (catalogs.${ch.table})`) : '';
    log.info(`${c.green('+ catalog')} ${ch.name}@${ch.to}${where}`);
  }
  for (const ch of plan.catalogEntriesDrift) {
    const where = ch.table ? c.gray(` (catalogs.${ch.table})`) : '';
    log.info(`${c.cyan('↑ catalog')} ${ch.name} ${ch.from} → ${ch.to}${where}`);
  }
  for (const ch of plan.devDepsPinned) {
    const at = ch.from ?? '(nicht installiert)';
    log.skip(`devDep ${ch.name} gehalten bei ${at} (lösen: udx unpin ${ch.name})`);
  }
  for (const ch of plan.scriptsDrift) {
    if (s.force) log.info(`${c.yellow('~ script')} ${ch.name}`);
    else log.warn(`script ${ch.name} weicht ab (bleibt; --force überschreibt)`);
  }

  if (s.dryRun) return NO_PATCH;
  // Nichts tatsächlich Schreibbares (z. B. nur gehaltene Deps gemeldet) → kein Mutieren.
  if (auto === 0 && !(s.force && scriptDrift > 0)) return NO_PATCH;
  const targetChanged = mutatePkg(targetPkg, plan, s.force);
  const rootCatalogChanged = applyCatalogEntries(s.catalog, plan);
  // `bun install` ist nur bei auto-Änderungen sinnvoll (reiner Script-Drift-Force ändert die Menge nicht).
  return {
    installable: (targetChanged || rootCatalogChanged) && auto > 0,
    targetChanged,
    rootCatalogChanged
  };
}

function printFooter(
  mode: 'init' | 'sync',
  ctx: ProjectContext,
  flags: HarnessFlags,
  results: FileResult[],
  declined: DeclinedSets,
  install: InstallPlan & { ok: boolean | null }
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
  // `bun install` lief bereits erfolgreich (installDeps hat es gemeldet) → kein weiterer Hinweis nötig.
  const installed = install.run && install.ok === true;
  if (mode === 'init') {
    const hooks = declined.scripts.has('prepare') ? '' : ' + Git-Hooks via prepare-Script';
    log.title('Nächste Schritte');
    log.info(
      `1. ${c.cyan('export CODEBERG_TOKEN=…')} ${c.gray('(Zugriff auf die @urbicon-Registry)')}`
    );
    if (installed) log.info(`2. ${c.green('✓')} ${c.gray('Abhängigkeiten installiert')}`);
    else {
      const tip = install.offer ? c.gray('  (oder gleich `udx init --install`)') : '';
      log.info(`2. ${c.cyan('bun install')} ${c.gray(`(Deps${hooks})`)}${tip}`);
    }
    log.info(`3. Scopes in ${c.cyan('commitlint.config.mjs')} ergänzen`);
    if (ctx.svelte)
      log.info(
        `4. ${c.cyan('bunx svelte-kit sync')} ${c.gray('(erzeugt .svelte-kit/tsconfig.json)')}`
      );
  } else {
    log.ok('Sync abgeschlossen.');
    if (install.offer)
      log.info(c.gray('Neue devDeps/Scripts — `bun install` (oder gleich `udx sync --install`).'));
  }
}

/**
 * Geht Konflikt-Dateien interaktiv durch: [u]pdate übernimmt das Template (gezieltes
 * Force-Write nur dieser Datei), [s]kip lässt die lokale Fassung, [d]iff zeigt den
 * Unterschied und fragt erneut. Leere Eingabe/EOF ⇒ konservativ skippen. Braucht ein TTY.
 */
function runInteractive(
  cwd: string,
  ctx: RenderCtx,
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
  const wiring = detectWiring(ctx);
  const wiringSkip = wiringSkipDeps(wiring);

  // --only: Auswahl auf konkrete Bausteine auflösen (null = alle).
  const validFileIds = new Set(FILE_TEMPLATES.map((t) => t.id));
  const selection: Selection | null =
    flags.only.length > 0 ? resolveSelection(flags.only, validFileIds) : null;
  const onlyFiles = selection ? selection.files : null;
  const onlyPkg: PkgSet | undefined = selection
    ? { scripts: selection.scripts, devDeps: selection.devDeps }
    : undefined;

  // Monorepo: package-scoped Bausteine (tsconfig) laufen je Paket, nicht im Root. Die gemeinsame
  // Workspace-Sicht (tsPkgs + rootTier + catalog) teilt sich harness mit status/doctor.
  const { catalog, isMonorepo, rootTier, svelteAnywhere, tsPkgs, workspaces } =
    resolveWorkspaceView(ctx, flags.svelte);
  // root-scoped Bausteine (lefthook, .prettierrc/.prettierignore) müssen `.svelte` aus allen Paketen
  // abdecken — daher der um svelteAnywhere angereicherte Ctx, nicht der ggf. non-svelte Root-Ctx.
  const rootCtx: RenderCtx = { ...ctx, svelteAnywhere };
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
    rootCtx,
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
  if (tsPkgs.length > 0) {
    log.plain();
    log.step('Pakete');
    for (const { ws, ctx: pkgCtx } of tsPkgs) {
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
  if (selection && allResults.length === 0)
    log.warn('--only: keine passende Datei angewandt (ggf. greift die applies-Bedingung nicht).');

  // Auto-Abwahlen nur ohne --only behandeln: --only ist chirurgisch (fasst nur die genannten
  // Bausteine an); die Abwahl ist deterministisch und wird vom nächsten vollen `sync` persistiert.
  // So entsteht keine stille Manifest-Mutation, die der unterdrückte Report nicht erklären würde.
  if (!selection) {
    if (!flags.dryRun) persistDeclines(capStates, manifest);
    reportCapabilities(capStates);
    reportWiring(wiring);
  }

  // Monorepo: Root trägt repo-globale + TS-Tools (ein svelte-Root = alles); jedes Svelte-Paket
  // bekommt sein Svelte-Werkzeug (Deps + svelte-flavored lint/format) — schließt den
  // Svelte-Monorepo-Gap (D9-C). Single-Package: ein Aufruf ohne Tier (= alles, bisheriges Verhalten).
  // Catalog-Modus (D9-A): das Root-pkg wird einmal gelesen, alle Patches mutieren das gemeinsame
  // `catalog`-Arbeitsobjekt (Akkumulation über Pakete) und das Root-pkg, das am Ende einmal geschrieben
  // wird (per `wireCatalog`) — so entsteht nie ein `catalog:`-devDep ohne seinen Eintrag.
  // Die pkg-Objekte sind bereits via detectContext gelesen (`{}` wenn die Datei fehlt) — wiederverwenden
  // statt erneut von der Platte zu lesen (robust auch im Dry-Run ohne package.json).
  const rootPkg = ctx.pkg;
  const shared: PatchShared = {
    dryRun: flags.dryRun,
    force: flags.force,
    declined,
    only: onlyPkg,
    pinned: new Set(Object.keys(manifest.pinned)),
    wiringSkip,
    catalog
  };

  let pkgChanged = false; // installierbare Änderungen (für installPlan)
  let rootDirty = false; // Root-pkg muss geschrieben werden (Scripts/devDeps oder Catalog)

  const rootRes = patchPkg(ctx, rootPkg, shared, rootTier);
  pkgChanged ||= rootRes.installable;
  rootDirty ||= rootRes.targetChanged || rootRes.rootCatalogChanged;

  for (const { ws, ctx: pkgCtx } of tsPkgs) {
    if (!pkgCtx.svelte) continue;
    const res = patchPkg(pkgCtx, pkgCtx.pkg, shared, 'svelte', `${ws}/package.json`);
    if (res.targetChanged && !flags.dryRun) writeJson(abs(pkgCtx.cwd, 'package.json'), pkgCtx.pkg);
    pkgChanged ||= res.installable;
    rootDirty ||= res.rootCatalogChanged;
  }

  // Akkumulierte Catalog-Einträge ins Root-pkg verdrahten und das Root-pkg genau einmal schreiben.
  if (rootDirty && !flags.dryRun) {
    if (shared.catalog) wireCatalog(rootPkg, shared.catalog);
    writeJson(abs(ctx.cwd, 'package.json'), rootPkg);
  }

  // Interaktiv nur Root-Konflikte: package-scoped Bausteine sind create-only (s. Guard in
  // templates/index.ts) und können daher nicht in Konflikt geraten.
  if (flags.interactive && !flags.dryRun) {
    runInteractive(
      ctx.cwd,
      rootCtx,
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

  // Opt-in `bun install` (D8): nur bei installierbaren Änderungen, sonst bietet der Footer es an.
  const ip = installPlan(flags, pkgChanged);
  const installOk = ip.run ? installDeps(ctx.cwd) : null;

  printFooter(mode, ctx, flags, allResults, declined, { ...ip, ok: installOk });
  // `bun install` angefordert, aber fehlgeschlagen → der Lauf gilt als nicht voll erfolgreich.
  return ip.run && installOk === false ? 1 : 0;
}
