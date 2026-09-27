import { basename } from 'node:path';
import {
  type ApplyOptions,
  applyFiles,
  type FileResult,
  pruneLegacyRegistry
} from '../lib/apply.ts';
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
  /** On drift, show the difference local → template. */
  diff: boolean;
  /** Process only these building blocks (capability or file ids); empty = all. */
  only: string[];
  /** Decide interactively per file on conflicts (requires a TTY). */
  interactive: boolean;
  /** Run `bun install` after a successful run (opt-in; otherwise the footer offers it). */
  install: boolean;
}

export interface InstallPlan {
  /** Actually run `bun install`. */
  run: boolean;
  /** Offer `--install` in the footer (changes present, but not requested). */
  offer: boolean;
}

/**
 * Purely decides whether `bun install` runs after the run or is only offered. Only meaningful when
 * the package.json received installable changes (new/bumped devDeps or scripts); in a dry run
 * nothing happens.
 */
export function installPlan(
  flags: { install: boolean; dryRun: boolean },
  pkgChanged: boolean
): InstallPlan {
  if (flags.dryRun || !pkgChanged) return { run: false, offer: false };
  return flags.install ? { run: true, offer: false } : { run: false, offer: true };
}

/** Runs `bun install` in the project (Bun-native, output passed through). Returns whether it succeeded. */
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
    // Bun.spawnSync throws (instead of success:false) when `bun` is not in $PATH.
    log.err(
      `bun install could not be started: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
  // success:false also when only a lifecycle script (e.g. prepare) failed but the deps were
  // installed — so point to the passed-through output instead of blanket "failed".
  if (success) log.ok('Dependencies installed.');
  else log.err('bun install did not complete cleanly (details above) — please check.');
  return success;
}

/** Persists fresh auto-declines into the manifest (a global fact, even under `--only`). */
function persistDeclines(states: CapabilityState[], manifest: Manifest): void {
  for (const s of states) {
    if (s.declined && s.fresh) manifest.declined[s.cap.id] = s.reason;
  }
}

/** Shows inactive building blocks unobtrusively (one line per block + a hint). */
function reportCapabilities(states: CapabilityState[]): void {
  const inactive = states.filter((s) => s.declined || s.available);
  if (inactive.length === 0) return;

  log.plain();
  log.step('Building blocks');
  for (const s of inactive) {
    const detail = s.available
      ? `available (opt-in) — \`udx add ${s.cap.id}\``
      : s.fresh
        ? `${s.reason} detected — skipped, remembered`
        : `declined (${s.reason})`;
    log.skip(`${s.cap.label}: ${detail}`);
  }
  const example = inactive[0]?.cap.id;
  log.info(
    c.gray(`Enable with \`udx add <id>\` (e.g. ${example}), decline with \`udx remove <id>\`.`)
  );
}

/** Reports self-managed configs neutrally and offers to adopt the udx template (D9). */
function reportWiring(wiring: WiringState[]): void {
  const self = wiring.filter((w) => w.status === 'self-managed');
  if (self.length === 0) return;

  log.plain();
  log.step('Wiring');
  for (const w of self) {
    log.skip(`${w.consuming}: ${w.dep} not wired — adopt with \`udx sync --only ${w.id} --force\``);
  }
  log.info(c.gray('… or keep your own config (do nothing).'));
}

function ensurePackageJson(cwd: string, dryRun: boolean): void {
  const path = abs(cwd, 'package.json');
  if (exists(path)) return;
  log.warn('no package.json found — creating a minimal one');
  if (dryRun) return;
  writeJson(path, {
    name: basename(cwd),
    version: '0.0.0',
    type: 'module',
    private: true,
    scripts: {}
  });
}

/** Shared inputs for all `patchPkg` calls of a run (root + Svelte packages). */
interface PatchShared {
  dryRun: boolean;
  force: boolean;
  declined: DeclinedSets;
  only: PkgSet | undefined;
  pinned: ReadonlySet<string>;
  /** Self-managed @urbicon-ui preset deps (wiring) — do not add. */
  wiringSkip: ReadonlySet<string>;
  /**
   * Mutable catalog working object of the consumer (read from the root pkg); `null` ⇒ literal mode
   * (D9-A). The entries of all patches collect here (accumulation across packages) and are wired by
   * the caller into the root pkg once via `wireCatalog`.
   */
  catalog: CatalogTables | null;
}

interface PatchResult {
  /** New/bumped deps, scripts or catalog changes → `bun install` makes sense. */
  installable: boolean;
  /** The target pkg (root or sub-package) was mutated → write it from the caller. */
  targetChanged: boolean;
  /** The shared root pkg (catalog entries) was mutated → write it once from the caller. */
  rootCatalogChanged: boolean;
}

const NO_PATCH: PatchResult = {
  installable: false,
  targetChanged: false,
  rootCatalogChanged: false
};

/**
 * Plans the package.json changes of a package and applies them **in-memory**: scripts/devDeps on
 * `targetPkg`, catalog entries on the shared `s.catalog` working object (Bun catalogs live only in
 * the root). Does NOT write — the caller persists `targetPkg` per package and wires the catalog into
 * the root pkg once via `wireCatalog`, so a `catalog:` devDep never arises without its entry.
 * `tier`/`label` control placement and heading.
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
  // Auto = applied without --force (add missing, safe bumps, catalog upkeep + switch).
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
    log.skip('Scripts & devDeps complete');
    return NO_PATCH;
  }

  for (const ch of plan.scriptsToAdd) log.info(`${c.green('+ script')} ${ch.name}`);
  for (const ch of plan.devDepsToAdd) log.info(`${c.green('+ devDep')} ${ch.name}@${ch.to}`);
  // Version drift is bumped safely (never a downgrade) — no --force needed.
  for (const ch of plan.devDepsDrift) {
    log.info(`${c.cyan('↑ devDep')} ${ch.name} ${ch.from} → ${ch.to}`);
  }
  // Renamed tool dep: the old name is removed in favor of the successor.
  for (const ch of plan.devDepsToRemove) {
    log.info(`${c.red('- devDep')} ${ch.name} ${c.gray(`(replaced by ${ch.to})`)}`);
  }
  // Catalog mode (D9): switch devDep to catalog:, create/bump entry.
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
    const at = ch.from ?? '(not installed)';
    log.skip(`devDep ${ch.name} pinned at ${at} (release: udx unpin ${ch.name})`);
  }
  for (const ch of plan.scriptsDrift) {
    if (s.force) log.info(`${c.yellow('~ script')} ${ch.name}`);
    else log.warn(`script ${ch.name} differs (kept; --force overwrites)`);
  }

  if (s.dryRun) return NO_PATCH;
  // Nothing actually writable (e.g. only pinned deps reported) → no mutation.
  if (auto === 0 && !(s.force && scriptDrift > 0)) return NO_PATCH;
  const targetChanged = mutatePkg(targetPkg, plan, s.force);
  const rootCatalogChanged = applyCatalogEntries(s.catalog, plan);
  // `bun install` only makes sense for auto changes (a pure script-drift force does not change the set).
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
      `${conflicts.length} locally modified file(s) protected: ${conflicts
        .map((r) => r.dest)
        .join(', ')}`
    );
    log.info(c.gray('Apply with `--force`.'));
  }

  log.plain();
  if (flags.dryRun) {
    log.info(c.gray('Dry run finished — run again without --dry-run to write.'));
    return;
  }
  // `bun install` already ran successfully (installDeps reported it) → no further note needed.
  const installed = install.run && install.ok === true;
  if (mode === 'init') {
    const hooks = declined.scripts.has('prepare') ? '' : ' + Git hooks via prepare script';
    log.title('Next steps');
    if (installed) log.info(`1. ${c.green('✓')} ${c.gray('Dependencies installed')}`);
    else {
      const tip = install.offer ? c.gray('  (or run `udx init --install` directly)') : '';
      log.info(`1. ${c.cyan('bun install')} ${c.gray(`(deps${hooks})`)}${tip}`);
    }
    log.info(`2. Add scopes in ${c.cyan('commitlint.config.mjs')}`);
    if (ctx.svelte)
      log.info(
        `3. ${c.cyan('bunx svelte-kit sync')} ${c.gray('(generates .svelte-kit/tsconfig.json)')}`
      );
  } else {
    log.ok('Sync complete.');
    if (install.offer)
      log.info(
        c.gray('New devDeps/scripts — `bun install` (or run `udx sync --install` directly).')
      );
  }
}

/**
 * Walks through conflict files interactively: [u]pdate applies the template (targeted
 * force-write of just this file), [s]kip keeps the local version, [d]iff shows the
 * difference and asks again. Empty input/EOF ⇒ conservatively skip. Needs a TTY.
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
    log.warn('--interactive needs a TTY — conflicts left unchanged.');
    return;
  }
  log.plain();
  log.step('Interactive');
  for (const cf of conflicts) {
    if (!cf.id) continue;
    let decision: 'u' | 's' | null = null;
    while (decision === null) {
      const raw = prompt(`  ${cf.dest} — [u]pdate / [s]kip / [d]iff?`);
      if (raw === null) {
        decision = 's'; // EOF ⇒ overwrite nothing
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
      // Targeted force-write of just this file; empty declined map, since the user
      // explicitly chose to apply it (overrides any prior decline).
      applyFiles(
        cwd,
        ctx,
        { mode, dryRun: false, force: true },
        manifest,
        new Map(),
        new Set([cf.id])
      );
      log.ok(`${cf.dest} applied`);
    } else {
      log.skip(`${cf.dest} left unchanged`);
    }
  }
}

/**
 * `manifestOverride` lets a caller pass through an already in-memory mutated manifest (instead of
 * reading it fresh from disk). `udx add` uses this: the adoption of a building block is then also
 * present in a dry run, otherwise a targeted `sync --only` would skip an auto-declined building
 * block. The manifest is persisted at the end as usual (except in a dry run).
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

  // --only: resolve the selection to concrete building blocks (null = all).
  const validFileIds = new Set(FILE_TEMPLATES.map((t) => t.id));
  const selection: Selection | null =
    flags.only.length > 0 ? resolveSelection(flags.only, validFileIds) : null;
  const onlyFiles = selection ? selection.files : null;
  const onlyPkg: PkgSet | undefined = selection
    ? { scripts: selection.scripts, devDeps: selection.devDeps }
    : undefined;

  // Monorepo: package-scoped building blocks (tsconfig) run per package, not in the root. The shared
  // workspace view (tsPkgs + rootTier + catalog) is shared by harness with status/doctor.
  const { catalog, isMonorepo, rootTier, svelteAnywhere, tsPkgs, workspaces } =
    resolveWorkspaceView(ctx, flags.svelte);
  // root-scoped building blocks (lefthook, .prettierrc/.prettierignore) must cover `.svelte` from all
  // packages — hence the ctx enriched with svelteAnywhere, not the possibly non-svelte root ctx.
  const rootCtx: RenderCtx = { ...ctx, svelteAnywhere };
  const baseOpts: ApplyOptions = {
    mode,
    dryRun: flags.dryRun,
    force: flags.force,
    diff: flags.diff
  };

  const label = mode === 'init' ? 'udx init' : 'udx sync';
  log.title(`${label} — ${ctx.projectName}${ctx.svelte ? c.gray(' (svelte)') : ''}`);
  if (flags.dryRun) log.info(`${c.yellow('Dry run')} — nothing is written`);
  if (isMonorepo) log.info(c.gray(`Monorepo — ${workspaces.length} package(s)`));
  if (selection && selection.unknown.length > 0)
    log.warn(`--only: unknown, ignored: ${selection.unknown.join(', ')}`);

  log.plain();
  log.step('Files');
  const results: FileResult[] = applyFiles(
    ctx.cwd,
    rootCtx,
    isMonorepo ? { ...baseOpts, scope: 'root' } : baseOpts,
    manifest,
    declined.files,
    onlyFiles
  );
  if (!selection) {
    const pruned = pruneLegacyRegistry(ctx.cwd, flags.dryRun);
    if (pruned) results.push(pruned);
  }
  for (const r of results) {
    // Inactive opt-ins appear once under Building blocks; an explicit `--only` lists their files.
    if (!selection && r.id && declined.unlisted.has(r.id)) continue;
    reportAction(r.action, r.dest, r.note);
    if (r.diff) log.block(r.diff);
  }
  // Overall view across root + packages (empty-match warning & conflict footer).
  const allResults: FileResult[] = [...results];

  // Per package the package-scoped building blocks (Svelte detected per package). Asset packages
  // without TS code are skipped, so no unnecessary tsconfigs arise everywhere.
  if (tsPkgs.length > 0) {
    log.plain();
    log.step('Packages');
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
    log.warn('--only: no matching file applied (the applies condition may not match).');

  // Handle auto-declines only without --only: --only is surgical (touches only the named building
  // blocks); the decline is deterministic and is persisted by the next full `sync`. This way no
  // silent manifest mutation arises that the suppressed report would not explain.
  if (!selection) {
    if (!flags.dryRun) persistDeclines(capStates, manifest);
    reportCapabilities(capStates);
    reportWiring(wiring);
  }

  // Monorepo: the root carries repo-global + TS tools (a svelte root = everything); each Svelte
  // package gets its Svelte tooling (deps + svelte-flavored lint/format) — closes the
  // Svelte monorepo gap (D9-C). Single-package: one call without tier (= everything, prior behavior).
  // Catalog mode (D9-A): the root pkg is read once, all patches mutate the shared
  // `catalog` working object (accumulation across packages) and the root pkg, which is written once
  // at the end (via `wireCatalog`) — so a `catalog:` devDep never arises without its entry.
  // The pkg objects are already read via detectContext (`{}` if the file is missing) — reuse them
  // instead of reading from disk again (robust even in a dry run without package.json).
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

  let pkgChanged = false; // installable changes (for installPlan)
  let rootDirty = false; // root pkg must be written (scripts/devDeps or catalog)

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

  // Wire accumulated catalog entries into the root pkg and write the root pkg exactly once.
  if (rootDirty && !flags.dryRun) {
    if (shared.catalog) wireCatalog(rootPkg, shared.catalog);
    writeJson(abs(ctx.cwd, 'package.json'), rootPkg);
  }

  // Interactive only for root conflicts: package-scoped building blocks are create-only (see guard in
  // templates/index.ts) and therefore cannot end up in conflict.
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
    log.skip(`Manifest ${MANIFEST_FILE} ${flags.dryRun ? 'would be updated' : 'updated'}`);
  }

  // Opt-in `bun install` (D8): only on installable changes, otherwise the footer offers it.
  const ip = installPlan(flags, pkgChanged);
  const installOk = ip.run ? installDeps(ctx.cwd) : null;

  printFooter(mode, ctx, flags, allResults, declined, { ...ip, ok: installOk });
  // `bun install` requested but failed → the run counts as not fully successful.
  return ip.run && installOk === false ? 1 : 0;
}
