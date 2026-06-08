import { URBICON_REGISTRY } from '../lib/apply.ts';
import { declinedSets, resolveCapabilities } from '../lib/capabilities.ts';
import { c } from '../lib/colors.ts';
import { detectContext } from '../lib/detect.ts';
import { abs, exists, readText } from '../lib/fs.ts';
import { log } from '../lib/log.ts';
import { hashContent, readManifest } from '../lib/manifest.ts';
import { computePkgPlan } from '../lib/pkg.ts';
import { FILE_TEMPLATES } from '../templates/index.ts';

export interface DoctorFlags {
  cwd: string;
  svelte: boolean | undefined;
}

export function runDoctor(flags: DoctorFlags): number {
  const ctx = detectContext(flags.cwd, flags.svelte);
  const manifest = readManifest(ctx.cwd);
  const capStates = resolveCapabilities(ctx, manifest);
  const declined = declinedSets(capStates);
  log.title(`udx doctor — ${ctx.projectName}${ctx.svelte ? c.gray(' (svelte)') : ''}`);

  let fails = 0;
  let warns = 0;
  const pass = (s: string) => log.ok(s);
  const warn = (s: string) => {
    warns++;
    log.warn(s);
  };
  const fail = (s: string) => {
    fails++;
    log.err(s);
  };

  log.plain();
  log.step('Dateien');
  for (const t of FILE_TEMPLATES) {
    if (t.applies && !t.applies(ctx)) continue;
    // Abgewählte Capability → kein Soll, daher kein Fehler.
    const reason = declined.files.get(t.id);
    if (reason) {
      log.skip(`${t.dest} abgewählt (${reason})`);
      continue;
    }
    const target = abs(ctx.cwd, t.dest);
    if (!exists(target)) {
      fail(`fehlt: ${t.dest}`);
      continue;
    }
    if (t.policy !== 'managed') {
      pass(t.dest);
      continue;
    }
    const local = readText(target);
    if (local === t.render(ctx)) {
      pass(t.dest);
      continue;
    }
    // managed + Drift: unberührt-veraltet vs. lokal geändert (3-Wege via Manifest).
    const known = manifest.files[t.dest];
    if (known !== undefined && hashContent(local) === known) {
      warn(`${t.dest} veraltet — \`udx sync\` aktualisiert`);
    } else {
      warn(`${t.dest} lokal geändert — \`udx sync --force\` überschreibt`);
    }
  }

  const declinedCaps = capStates.filter((s) => s.declined);
  if (declinedCaps.length > 0) {
    log.plain();
    log.step('Bausteine');
    for (const s of declinedCaps) {
      if (s.stale) {
        warn(
          `${s.cap.label}: als '${s.reason}' abgewählt, aber ${s.reason} nicht mehr erkannt — ` +
            `\`udx adopt ${s.cap.id}\``
        );
      } else {
        log.skip(`${s.cap.label}: abgewählt (${s.reason})`);
      }
    }
  }

  log.plain();
  log.step('Registry');
  const bunfig = abs(ctx.cwd, 'bunfig.toml');
  if (exists(bunfig) && readText(bunfig).includes(URBICON_REGISTRY))
    pass('bunfig.toml @urbicon-Registry');
  else fail('bunfig.toml @urbicon-Registry fehlt');

  log.plain();
  log.step('package.json');
  const plan = computePkgPlan(ctx, { scripts: declined.scripts, devDeps: declined.devDeps });
  if (plan.scriptsToAdd.length === 0) pass('Scripts vollständig');
  else fail(`fehlende Scripts: ${plan.scriptsToAdd.map((s) => s.name).join(', ')}`);
  if (plan.devDepsToAdd.length === 0) pass('devDeps vollständig');
  else fail(`fehlende devDeps: ${plan.devDepsToAdd.map((s) => s.name).join(', ')}`);
  for (const ch of plan.scriptsDrift) warn(`script ${ch.name} weicht ab`);
  for (const ch of plan.devDepsDrift) warn(`devDep ${ch.name} ${ch.from ?? '?'} ≠ ${ch.to}`);

  log.plain();
  if (fails > 0) {
    log.err(`${fails} Problem(e), ${warns} Warnung(en) — \`udx sync\` ausführen`);
    return 1;
  }
  if (warns > 0) {
    log.warn(`${warns} Warnung(en) — ggf. \`udx sync\``);
    return 0;
  }
  log.ok('Harness vollständig & in sync.');
  return 0;
}
