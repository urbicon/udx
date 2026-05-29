import { basename } from 'node:path';
import { applyFiles, ensureBunfig, type FileResult } from '../lib/apply.ts';
import { c } from '../lib/colors.ts';
import { detectContext, type PackageJson, type ProjectContext } from '../lib/detect.ts';
import { abs, exists, readJson, writeJson } from '../lib/fs.ts';
import { log, reportAction } from '../lib/log.ts';
import { computePkgPlan, mutatePkg } from '../lib/pkg.ts';

export interface HarnessFlags {
  cwd: string;
  dryRun: boolean;
  force: boolean;
  svelte: boolean | undefined;
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

function patchPkg(ctx: ProjectContext, dryRun: boolean, force: boolean): void {
  const plan = computePkgPlan(ctx);
  const adds = plan.scriptsToAdd.length + plan.devDepsToAdd.length;
  const drift = plan.scriptsDrift.length + plan.devDepsDrift.length;

  log.plain();
  log.step('package.json');

  if (adds === 0 && drift === 0) {
    log.skip('Scripts & devDeps vollständig');
    return;
  }

  for (const ch of plan.scriptsToAdd) log.info(`${c.green('+ script')} ${ch.name}`);
  for (const ch of plan.devDepsToAdd) log.info(`${c.green('+ devDep')} ${ch.name}@${ch.to}`);
  for (const ch of plan.scriptsDrift) {
    if (force) log.info(`${c.yellow('~ script')} ${ch.name}`);
    else log.warn(`script ${ch.name} weicht ab (bleibt; --force überschreibt)`);
  }
  for (const ch of plan.devDepsDrift) {
    if (force) log.info(`${c.yellow('~ devDep')} ${ch.name} ${ch.from} → ${ch.to}`);
    else log.warn(`devDep ${ch.name} ${ch.from ?? '?'} ≠ ${ch.to} (bleibt; --force überschreibt)`);
  }

  if (dryRun) return;
  const pkg = readJson<PackageJson>(abs(ctx.cwd, 'package.json'));
  if (mutatePkg(pkg, plan, force)) writeJson(abs(ctx.cwd, 'package.json'), pkg);
}

function printFooter(mode: 'init' | 'sync', ctx: ProjectContext, flags: HarnessFlags): void {
  log.plain();
  if (flags.dryRun) {
    log.info(c.gray('Dry-Run beendet — ohne --dry-run erneut ausführen, um zu schreiben.'));
    return;
  }
  if (mode === 'init') {
    log.title('Nächste Schritte');
    log.info(
      `1. ${c.cyan('export CODEBERG_TOKEN=…')} ${c.gray('(Zugriff auf die @urbicon-Registry)')}`
    );
    log.info(`2. ${c.cyan('bun install')} ${c.gray('(Deps + Git-Hooks via prepare-Script)')}`);
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

export function runHarness(mode: 'init' | 'sync', flags: HarnessFlags): number {
  ensurePackageJson(flags.cwd, flags.dryRun);
  const ctx = detectContext(flags.cwd, flags.svelte);

  const label = mode === 'init' ? 'udx init' : 'udx sync';
  log.title(`${label} — ${ctx.projectName}${ctx.svelte ? c.gray(' (svelte)') : ''}`);
  if (flags.dryRun) log.info(`${c.yellow('Dry-Run')} — es wird nichts geschrieben`);

  log.plain();
  log.step('Dateien');
  const results: FileResult[] = applyFiles(ctx.cwd, ctx, {
    mode,
    dryRun: flags.dryRun,
    force: flags.force
  });
  results.push(ensureBunfig(ctx.cwd, flags.dryRun));
  for (const r of results) reportAction(r.action, r.dest, r.note);

  patchPkg(ctx, flags.dryRun, flags.force);
  printFooter(mode, ctx, flags);
  return 0;
}
