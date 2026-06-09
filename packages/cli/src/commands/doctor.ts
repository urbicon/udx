import { URBICON_REGISTRY } from '../lib/apply.ts';
import { declinedSets, resolveCapabilities } from '../lib/capabilities.ts';
import { c } from '../lib/colors.ts';
import { detectContext } from '../lib/detect.ts';
import { formatDiff } from '../lib/diff.ts';
import { abs, exists, readText } from '../lib/fs.ts';
import { log } from '../lib/log.ts';
import { hashContent, readManifest } from '../lib/manifest.ts';
import { planWorkspace, resolveWorkspaceView } from '../lib/targets.ts';
import { detectWiring, wiringSkipDeps } from '../lib/wiring.ts';
import { FILE_TEMPLATES } from '../templates/index.ts';

export interface DoctorFlags {
  cwd: string;
  svelte: boolean | undefined;
  /** Bei abweichenden managed-Dateien den Unterschied lokal → Template anzeigen. */
  diff: boolean;
}

export function runDoctor(flags: DoctorFlags): number {
  const ctx = detectContext(flags.cwd, flags.svelte);
  const manifest = readManifest(ctx.cwd);
  const capStates = resolveCapabilities(ctx, manifest);
  const declined = declinedSets(capStates);
  const wiring = detectWiring(ctx);
  const wiringSkip = wiringSkipDeps(wiring);
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

  // Gemeinsame Workspace-Sicht mit init/sync/status: TS-Pakete (für package-scoped Dateien + den
  // per-Svelte-Paket-Plan, D9-C), das Root-Tier und der Catalog (D9-A).
  const view = resolveWorkspaceView(ctx, flags.svelte);
  const { isMonorepo, tsPkgs } = view;

  log.plain();
  log.step('Dateien');
  for (const t of FILE_TEMPLATES) {
    // Im Monorepo werden package-scoped Bausteine je Paket geprüft (unten).
    if (isMonorepo && (t.scope ?? 'root') !== 'root') continue;
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
    const expected = t.render(ctx);
    if (local === expected) {
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
    if (flags.diff) {
      const d = formatDiff(local, expected, { color: true });
      if (d) log.block(d);
    }
  }

  // Monorepo: package-scoped Bausteine je TS-Paket (Asset-Pakete ohne TS-Code übersprungen).
  // tsconfig ist create-only ⇒ nur Existenz prüfen, kein managed-Drift.
  if (tsPkgs.length > 0) {
    log.plain();
    log.step('Pakete');
    for (const { ws, ctx: pkgCtx } of tsPkgs) {
      for (const t of FILE_TEMPLATES) {
        if ((t.scope ?? 'root') !== 'package') continue;
        if (t.applies && !t.applies(pkgCtx)) continue;
        // Konsistent zur Root-Schleife: abgewählte Capability ⇒ kein Soll (defensiv —
        // aktuell referenziert keine Capability einen package-scoped Baustein).
        const reason = declined.files.get(t.id);
        if (reason) log.skip(`${ws}/${t.dest} abgewählt (${reason})`);
        else if (exists(abs(pkgCtx.cwd, t.dest))) pass(`${ws}/${t.dest}`);
        else fail(`fehlt: ${ws}/${t.dest}`);
      }
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
            `\`udx add ${s.cap.id}\``
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

  const selfManaged = wiring.filter((w) => w.status === 'self-managed');
  if (selfManaged.length > 0) {
    log.plain();
    log.step('Verdrahtung');
    for (const w of selfManaged) {
      // Selbstverwaltete Config ist eine bewusste Wahl, kein Fehler — neutral melden.
      log.skip(`${w.consuming}: ${w.dep} nicht verdrahtet (udx sync --only ${w.id} --force)`);
    }
  }

  log.plain();
  log.step('package.json');
  const pkgFilter = {
    skip: { scripts: declined.scripts, devDeps: new Set([...declined.devDeps, ...wiringSkip]) },
    pinned: new Set(Object.keys(manifest.pinned))
  };
  // Root-Tier (svelte-Root = alles) + je Svelte-Paket das svelte-Tier (D9-C); Label kennzeichnet das Paket.
  // Mit Catalog-Akkumulation planen (wie der echte sync, D9-A/E) — so meldet doctor exakt dessen Ergebnis.
  const catLabel = (ch: { name: string; table: string | null }) =>
    ch.table ? `${ch.name} (catalogs.${ch.table})` : ch.name;
  const { targets, catalogChanges } = planWorkspace(view, pkgFilter);
  for (const { ws, plan } of targets) {
    const label = ws ? `${ws}: ` : '';
    if (plan.scriptsToAdd.length === 0) pass(`${label}Scripts vollständig`);
    else fail(`${label}fehlende Scripts: ${plan.scriptsToAdd.map((s) => s.name).join(', ')}`);
    if (plan.devDepsToAdd.length === 0 && plan.devDepsToCatalog.length === 0)
      pass(`${label}devDeps vollständig`);
    else if (plan.devDepsToAdd.length > 0)
      fail(`${label}fehlende devDeps: ${plan.devDepsToAdd.map((s) => s.name).join(', ')}`);
    for (const ch of plan.devDepsToCatalog)
      warn(`${label}devDep ${ch.name} ${ch.from} → ${ch.to} (sync stellt um)`);
    for (const ch of plan.scriptsDrift) warn(`${label}script ${ch.name} weicht ab`);
    for (const ch of plan.devDepsDrift)
      warn(`${label}devDep ${ch.name} ${ch.from ?? '?'} → ${ch.to} (sync zieht hoch)`);
    for (const ch of plan.devDepsPinned)
      log.skip(`${label}devDep ${ch.name} gehalten bei ${ch.from ?? '(nicht installiert)'}`);
  }
  // Catalog-Einträge sind Root-global: die effektive Differenz nach Akkumulation. Fehlend ⇒ fail
  // (catalog:-devDep ohne Eintrag bricht bun install), hinter Pin ⇒ warn (sync zieht sicher hoch).
  for (const ch of catalogChanges) {
    if (ch.from === undefined) fail(`fehlender Catalog-Eintrag: ${catLabel(ch)} → ${ch.to}`);
    else warn(`Catalog ${catLabel(ch)} ${ch.from} → ${ch.to} (sync zieht hoch)`);
  }

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
