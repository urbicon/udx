import { URBICON_REGISTRY } from '../lib/apply.ts';
import { declinedSets, resolveCapabilities } from '../lib/capabilities.ts';
import { c } from '../lib/colors.ts';
import { detectContext } from '../lib/detect.ts';
import { formatDiff } from '../lib/diff.ts';
import { abs, exists, readText } from '../lib/fs.ts';
import { log } from '../lib/log.ts';
import { hashContent, readManifest } from '../lib/manifest.ts';
import { planWorkspace, resolveWorkspaceView } from '../lib/targets.ts';
import { VERSIONS } from '../lib/versions.ts';
import { detectWiring, wiringSkipDeps } from '../lib/wiring.ts';
import { FILE_TEMPLATES, type RenderCtx } from '../templates/index.ts';

export interface DoctorFlags {
  cwd: string;
  svelte: boolean | undefined;
  /** For diverging managed files, show the difference local → template. */
  diff: boolean;
}

/** Schema URL → version capture; operator prefix of a pin. Top-level (regex performance). */
const BIOME_SCHEMA_RE = /biomejs\.dev\/schemas\/([^/"]+)\/schema\.json/;
const RANGE_OPERATOR_RE = /^[\^~]/;

/** Reads the biome version from the `$schema` URL of a biome.json (null if none is detectable). */
export function biomeSchemaVersion(biomeJson: string): string | null {
  return biomeJson.match(BIOME_SCHEMA_RE)?.[1] ?? null;
}

/** `useTabs: true` in a .prettierrc — collides with Biome's space indent. Top-level (regex perf). */
const PRETTIER_USETABS_RE = /"useTabs"\s*:\s*true\b/;

/**
 * True if a .prettierrc sets `useTabs: true`. Parses the JSON form (the shape udx writes); falls
 * back to a regex so a JSON5/commented `.prettierrc` is still recognized rather than silently
 * passing. Detects the cross-formatter indent conflict (Prettier tabs vs. Biome spaces).
 */
export function prettierUsesTabs(prettierrc: string): boolean {
  try {
    return (JSON.parse(prettierrc) as { useTabs?: unknown }).useTabs === true;
  } catch {
    return PRETTIER_USETABS_RE.test(prettierrc);
  }
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
  const pass = (s: string): void => log.ok(s);
  const warn = (s: string): void => {
    warns++;
    log.warn(s);
  };
  const fail = (s: string): void => {
    fails++;
    log.err(s);
  };

  // Shared workspace view with init/sync/status: TS packages (for package-scoped files + the
  // per-Svelte-package plan, D9-C), the root tier and the catalog (D9-A).
  const view = resolveWorkspaceView(ctx, flags.svelte);
  const { isMonorepo, svelteAnywhere, tsPkgs } = view;
  // root-scoped building blocks must cover `.svelte` from all packages — compute the target with
  // svelteAnywhere, otherwise the doctor target diverges from what init/sync write.
  const rootCtx: RenderCtx = { ...ctx, svelteAnywhere };

  log.plain();
  log.step('Files');
  for (const t of FILE_TEMPLATES) {
    // In a monorepo, package-scoped building blocks are checked per package (below).
    if (isMonorepo && (t.scope ?? 'root') !== 'root') continue;
    if (t.applies && !t.applies(rootCtx)) continue;
    // Declined capability → no target, hence no error.
    const reason = declined.files.get(t.id);
    if (reason) {
      log.skip(`${t.dest} declined (${reason})`);
      continue;
    }
    const target = abs(ctx.cwd, t.dest);
    if (!exists(target)) {
      fail(`missing: ${t.dest}`);
      continue;
    }
    if (t.policy !== 'managed') {
      pass(t.dest);
      continue;
    }
    const local = readText(target);
    const expected = t.render(rootCtx);
    if (local === expected) {
      pass(t.dest);
      continue;
    }
    // managed + drift: untouched-stale vs. locally modified (3-way via manifest).
    const known = manifest.files[t.dest];
    if (known !== undefined && hashContent(local) === known) {
      warn(`${t.dest} stale — \`udx sync\` updates it`);
    } else {
      warn(`${t.dest} locally modified — \`udx sync --force\` overwrites`);
    }
    if (flags.diff) {
      const d = formatDiff(local, expected, { color: true });
      if (d) log.block(d);
    }
  }

  // biome.json is create-only ⇒ sync does not catch up the exact `$schema` version. If it drifts
  // behind the biome pin, biome itself reports a schema mismatch — make it visible here as a warning.
  // The Renovate customManager (renovate.json) normally catches it up automatically (biome.json +
  // catalog in the same PR); this warning covers the rest (no Renovate / not yet run / manual
  // stack:update).
  if (!declined.files.get('biome')) {
    const biomeJson = abs(ctx.cwd, 'biome.json');
    if (exists(biomeJson)) {
      const schemaV = biomeSchemaVersion(readText(biomeJson));
      const pinned = VERSIONS['@biomejs/biome'].replace(RANGE_OPERATOR_RE, '');
      if (schemaV && schemaV !== pinned)
        warn(
          `biome.json $schema ${schemaV} lags behind biome ${pinned} — ` +
            '`udx sync --only biome --force` (or adjust $schema)'
        );
    }
  }

  // .prettierrc is create-only (project preferences stay), so sync never rewrites it. But
  // `useTabs: true` collides with Biome's `indentStyle: space`: as soon as Prettier touches a JSON/TS
  // file (an editor's format-on-save, or a too-open .prettierignore) it flips the indent to tabs and
  // the next Biome run flips it back — package.json ping-pongs between styles. Surface it as a
  // warning; the fix is `useTabs: false` (Biome owns JSON/TS, Prettier only .svelte). The .prettierignore
  // side of the same conflict is now caught by the managed drift check above.
  const prettierrc = abs(ctx.cwd, '.prettierrc');
  if (exists(prettierrc) && prettierUsesTabs(readText(prettierrc)))
    warn(
      '.prettierrc `useTabs: true` collides with Biome `indentStyle: space` — set `useTabs: false` ' +
        '(Biome formats JSON/TS, Prettier only .svelte)'
    );

  // Monorepo: package-scoped building blocks per TS package (asset packages without TS code skipped).
  // tsconfig is create-only ⇒ only check existence, no managed drift.
  if (tsPkgs.length > 0) {
    log.plain();
    log.step('Packages');
    for (const { ws, ctx: pkgCtx } of tsPkgs) {
      for (const t of FILE_TEMPLATES) {
        if ((t.scope ?? 'root') !== 'package') continue;
        if (t.applies && !t.applies(pkgCtx)) continue;
        // Consistent with the root loop: declined capability ⇒ no target (defensive —
        // currently no capability references a package-scoped building block).
        const reason = declined.files.get(t.id);
        if (reason) log.skip(`${ws}/${t.dest} declined (${reason})`);
        else if (exists(abs(pkgCtx.cwd, t.dest))) pass(`${ws}/${t.dest}`);
        else fail(`missing: ${ws}/${t.dest}`);
      }
    }
  }

  const declinedCaps = capStates.filter((s) => s.declined);
  if (declinedCaps.length > 0) {
    log.plain();
    log.step('Building blocks');
    for (const s of declinedCaps) {
      if (s.stale) {
        warn(
          `${s.cap.label}: declined as '${s.reason}', but ${s.reason} no longer detected — ` +
            `\`udx add ${s.cap.id}\``
        );
      } else {
        log.skip(`${s.cap.label}: declined (${s.reason})`);
      }
    }
  }

  log.plain();
  log.step('Registry');
  const bunfig = abs(ctx.cwd, 'bunfig.toml');
  if (exists(bunfig) && readText(bunfig).includes(URBICON_REGISTRY))
    pass('bunfig.toml @urbicon registry');
  else fail('bunfig.toml @urbicon registry missing');

  const selfManaged = wiring.filter((w) => w.status === 'self-managed');
  if (selfManaged.length > 0) {
    log.plain();
    log.step('Wiring');
    for (const w of selfManaged) {
      // A self-managed config is a deliberate choice, not an error — report it neutrally.
      log.skip(`${w.consuming}: ${w.dep} not wired (udx sync --only ${w.id} --force)`);
    }
  }

  log.plain();
  log.step('package.json');
  const pkgFilter = {
    skip: { scripts: declined.scripts, devDeps: new Set([...declined.devDeps, ...wiringSkip]) },
    pinned: new Set(Object.keys(manifest.pinned))
  };
  // Root tier (svelte root = everything) + the svelte tier per Svelte package (D9-C); the label marks the package.
  // Plan with catalog accumulation (like the real sync, D9-A/E) — so doctor reports exactly its result.
  const catLabel = (ch: { name: string; table: string | null }): string =>
    ch.table ? `${ch.name} (catalogs.${ch.table})` : ch.name;
  const { targets, catalogChanges } = planWorkspace(view, pkgFilter);
  for (const { ws, plan } of targets) {
    const label = ws ? `${ws}: ` : '';
    if (plan.scriptsToAdd.length === 0) pass(`${label}scripts complete`);
    else fail(`${label}missing scripts: ${plan.scriptsToAdd.map((s) => s.name).join(', ')}`);
    if (plan.devDepsToAdd.length === 0 && plan.devDepsToCatalog.length === 0)
      pass(`${label}devDeps complete`);
    else if (plan.devDepsToAdd.length > 0)
      fail(`${label}missing devDeps: ${plan.devDepsToAdd.map((s) => s.name).join(', ')}`);
    for (const ch of plan.devDepsToCatalog)
      warn(`${label}devDep ${ch.name} ${ch.from} → ${ch.to} (sync switches it)`);
    for (const ch of plan.devDepsToRemove)
      warn(`${label}devDep ${ch.name} replaced by ${ch.to} (sync removes it)`);
    for (const ch of plan.scriptsDrift) warn(`${label}script ${ch.name} diverges`);
    for (const ch of plan.devDepsDrift)
      warn(`${label}devDep ${ch.name} ${ch.from ?? '?'} → ${ch.to} (sync bumps it)`);
    for (const ch of plan.devDepsPinned)
      log.skip(`${label}devDep ${ch.name} pinned at ${ch.from ?? '(not installed)'}`);
  }
  // Catalog entries are root-global: the effective difference after accumulation. Missing ⇒ fail
  // (a catalog: devDep without an entry breaks bun install), behind the pin ⇒ warn (sync bumps it safely).
  for (const ch of catalogChanges) {
    if (ch.from === undefined) fail(`missing catalog entry: ${catLabel(ch)} → ${ch.to}`);
    else warn(`catalog ${catLabel(ch)} ${ch.from} → ${ch.to} (sync bumps it)`);
  }

  log.plain();
  if (fails > 0) {
    log.err(`${fails} problem(s), ${warns} warning(s) — run \`udx sync\``);
    return 1;
  }
  if (warns > 0) {
    log.warn(`${warns} warning(s) — consider \`udx sync\``);
    return 0;
  }
  log.ok('Harness complete & in sync.');
  return 0;
}
