import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdd, runAdopt, runSkip } from '../src/commands/capability.ts';
import { installPlan, runHarness } from '../src/commands/harness.ts';
import { helpText } from '../src/commands/help.ts';
import { runPin, runUnpin } from '../src/commands/pin.ts';
import { buildReport, runStatus } from '../src/commands/status.ts';
import { type ApplyOptions, applyFiles, ensureBunfig, URBICON_REGISTRY } from '../src/lib/apply.ts';
import {
  CAPABILITIES,
  declinedSets,
  resolveCapabilities,
  resolveSelection
} from '../src/lib/capabilities.ts';
import { readCatalogTables, selectCatalogTable } from '../src/lib/catalog.ts';
import { detectContext, type ProjectContext } from '../src/lib/detect.ts';
import { formatDiff } from '../src/lib/diff.ts';
import {
  emptyManifest,
  hashContent,
  MANIFEST_FILE,
  type Manifest,
  readManifest,
  writeManifest
} from '../src/lib/manifest.ts';
import {
  canonicalDevDeps,
  canonicalScripts,
  computePkgPlan,
  mutatePkg,
  raise,
  satisfiesPin
} from '../src/lib/pkg.ts';
import { SVELTE_DEPS, TOOL_DEPS, VERSIONS } from '../src/lib/versions.ts';
import { detectWiring, wiringSkipDeps } from '../src/lib/wiring.ts';
import { isTypeScriptPackage, resolveWorkspaces } from '../src/lib/workspace.ts';
import { FILE_TEMPLATES } from '../src/templates/index.ts';

function project(pkg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'udx-test-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

/**
 * Legt ein Monorepo an: Root + packages/api (TS, mit src/) + packages/ui (Svelte). `objectForm` nutzt
 * `workspaces.packages`; `catalog` (impliziert Objekt-Form) hängt einen Bun-Catalog an = Catalog-Modus.
 */
function monorepo(objectForm = false, catalog?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'udx-mono-'));
  const workspaces =
    objectForm || catalog
      ? { packages: ['packages/*'], ...(catalog ? { catalog } : {}) }
      : ['packages/*'];
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces }));
  mkdirSync(join(dir, 'packages/api/src'), { recursive: true }); // src/ ⇒ TS-Paket
  writeFileSync(join(dir, 'packages/api/package.json'), JSON.stringify({ name: 'api' }));
  mkdirSync(join(dir, 'packages/ui'), { recursive: true });
  writeFileSync(
    join(dir, 'packages/ui/package.json'),
    JSON.stringify({ name: 'ui', devDependencies: { svelte: '^5' } })
  );
  return dir;
}

const HARNESS_DEFAULTS = {
  force: false,
  svelte: undefined,
  diff: false,
  only: [],
  interactive: false,
  install: false
};

/** applyFiles mit frischem Manifest (für Tests, die den Manifest-State nicht selbst stellen). */
function apply(
  dir: string,
  ctx: ProjectContext,
  opts: ApplyOptions,
  manifest: Manifest = emptyManifest()
) {
  return applyFiles(dir, ctx, opts, manifest);
}

const INIT: ApplyOptions = { mode: 'init', dryRun: false, force: false };
const SYNC: ApplyOptions = { mode: 'sync', dryRun: false, force: false };

/** ANSI-Escapes entfernen, damit der Hilfe-Snapshot unabhängig von TTY/NO_COLOR stabil ist. */
const stripAnsi = (s: string): string =>
  s.replace(new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'g'), '');

describe('detectContext', () => {
  test('erkennt Svelte über devDependencies', () => {
    expect(detectContext(project({ name: 'x', devDependencies: { svelte: '^5' } })).svelte).toBe(
      true
    );
  });
  test('reines TS-Projekt ist nicht svelte', () => {
    expect(detectContext(project({ name: 'x' })).svelte).toBe(false);
  });
  test('override erzwingt svelte', () => {
    expect(detectContext(project({ name: 'x' }), true).svelte).toBe(true);
  });
});

describe('applyFiles', () => {
  test('init erstellt managed + create-only Dateien', () => {
    const dir = project({ name: 'x' });
    apply(dir, detectContext(dir), INIT);
    expect(existsSync(join(dir, 'cliff.toml'))).toBe(true);
    expect(existsSync(join(dir, 'biome.json'))).toBe(true);
    expect(existsSync(join(dir, 'scripts/bump.sh'))).toBe(true);
  });

  test('dry-run schreibt nichts', () => {
    const dir = project({ name: 'x' });
    apply(dir, detectContext(dir), { mode: 'init', dryRun: true, force: false });
    expect(existsSync(join(dir, 'cliff.toml'))).toBe(false);
  });

  test('create-only bleibt bei sync erhalten', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    const m = emptyManifest();
    applyFiles(dir, ctx, INIT, m);
    writeFileSync(join(dir, 'biome.json'), '{"custom":true}');
    const res = applyFiles(dir, ctx, SYNC, m);
    expect(readFileSync(join(dir, 'biome.json'), 'utf8')).toBe('{"custom":true}');
    expect(res.find((r) => r.dest === 'biome.json')?.action).toBe('skipped');
  });

  test('svelte: biome ignoriert .svelte, .prettierrc existiert', () => {
    const dir = project({ name: 'x', devDependencies: { svelte: '^5' } });
    apply(dir, detectContext(dir), INIT);
    expect(readFileSync(join(dir, 'biome.json'), 'utf8')).toContain('!**/*.svelte');
    expect(existsSync(join(dir, '.prettierrc'))).toBe(true);
  });

  test('reines TS-Projekt bekommt keine prettier-Dateien', () => {
    const dir = project({ name: 'x' });
    apply(dir, detectContext(dir), INIT);
    expect(existsSync(join(dir, '.prettierrc'))).toBe(false);
  });

  test('biome.json schließt .svelte immer aus — auch ohne Svelte (Monorepo-Root-Schutz)', () => {
    const dir = project({ name: 'x' }); // reines TS, kein svelte
    apply(dir, detectContext(dir), INIT);
    expect(readFileSync(join(dir, 'biome.json'), 'utf8')).toContain('!**/*.svelte');
  });
});

describe('3-Wege-Drift (managed)', () => {
  test('init merkt Hashes managed-Dateien, nicht create-only', () => {
    const dir = project({ name: 'x' });
    const m = emptyManifest();
    applyFiles(dir, detectContext(dir), INIT, m);
    expect(m.files['cliff.toml']).toBeDefined();
    expect(m.files['scripts/bump.sh']).toBeDefined();
    expect(m.files['biome.json']).toBeUndefined();
  });

  test('unberührt-veraltete managed-Datei wird via sync aktualisiert', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    // Simuliert: udx schrieb früher "ALT\n" und merkte sich dessen Hash.
    writeFileSync(join(dir, 'cliff.toml'), 'ALT\n');
    const m: Manifest = { ...emptyManifest(), files: { 'cliff.toml': hashContent('ALT\n') } };
    const res = applyFiles(dir, ctx, SYNC, m);
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).not.toBe('ALT\n');
    expect(res.find((r) => r.dest === 'cliff.toml')?.action).toBe('updated');
    expect(m.files['cliff.toml']).toBe(hashContent(readFileSync(join(dir, 'cliff.toml'), 'utf8')));
  });

  test('lokal geänderte managed-Datei wird von sync geschützt, --force übernimmt', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    writeFileSync(join(dir, 'cliff.toml'), 'EDITED\n');
    // gemerkter Hash zeigt auf einen anderen ("ALT") Stand ⇒ lokal verändert.
    const m: Manifest = { ...emptyManifest(), files: { 'cliff.toml': hashContent('ALT\n') } };

    const res = applyFiles(dir, ctx, SYNC, m);
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).toBe('EDITED\n');
    expect(res.find((r) => r.dest === 'cliff.toml')?.action).toBe('conflict');

    const forced = applyFiles(dir, ctx, { ...SYNC, force: true }, m);
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).not.toBe('EDITED\n');
    expect(forced.find((r) => r.dest === 'cliff.toml')?.action).toBe('updated');
    // Hash rückt auf den geschriebenen Stand vor ⇒ der nächste sync sieht keinen Konflikt.
    expect(m.files['cliff.toml']).toBe(hashContent(readFileSync(join(dir, 'cliff.toml'), 'utf8')));
  });

  test('fremde Datei ohne gemerkten Hash gilt als Konflikt (Erstmigration)', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'cliff.toml'), 'FREMD\n');
    const res = applyFiles(dir, detectContext(dir), SYNC, emptyManifest());
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).toBe('FREMD\n');
    expect(res.find((r) => r.dest === 'cliff.toml')?.action).toBe('conflict');
  });

  test('identische Datei ohne Manifest-Eintrag wird nachgetragen (unchanged)', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    applyFiles(dir, ctx, INIT, emptyManifest()); // legt cliff.toml im Template-Stand an
    const m = emptyManifest(); // frisches Manifest ohne Hash
    const res = applyFiles(dir, ctx, SYNC, m);
    expect(res.find((r) => r.dest === 'cliff.toml')?.action).toBe('unchanged');
    expect(m.files['cliff.toml']).toBeDefined();
  });

  test('dry-run mutiert das Manifest nicht', () => {
    const dir = project({ name: 'x' });
    const m = emptyManifest();
    applyFiles(dir, detectContext(dir), { mode: 'init', dryRun: true, force: false }, m);
    expect(Object.keys(m.files)).toHaveLength(0);
  });
});

describe('applyFiles force-Modus', () => {
  test('init --force überschreibt lokal geänderte managed-Datei', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    const m = emptyManifest();
    applyFiles(dir, ctx, INIT, m);
    writeFileSync(join(dir, 'cliff.toml'), '# eigenes');
    const res = applyFiles(dir, ctx, { mode: 'init', dryRun: false, force: true }, m);
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).not.toBe('# eigenes');
    expect(res.find((r) => r.dest === 'cliff.toml')?.action).toBe('updated');
  });

  test('init ohne force meldet lokal geänderte managed-Datei als Konflikt', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    const m = emptyManifest();
    applyFiles(dir, ctx, INIT, m);
    writeFileSync(join(dir, 'cliff.toml'), '# eigenes');
    const res = applyFiles(dir, ctx, INIT, m);
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).toBe('# eigenes');
    expect(res.find((r) => r.dest === 'cliff.toml')?.action).toBe('conflict');
  });
});

describe('manifest', () => {
  test('readManifest gibt leeres Manifest ohne Datei zurück', () => {
    const dir = project({ name: 'x' });
    expect(readManifest(dir)).toEqual(emptyManifest());
  });

  test('writeManifest schreibt .udx.json und ist idempotent', () => {
    const dir = project({ name: 'x' });
    const m: Manifest = { ...emptyManifest(), harness: '1.0.0', files: { 'cliff.toml': 'abc' } };
    expect(writeManifest(dir, m, false)).toBe(true);
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(true);
    expect(writeManifest(dir, m, false)).toBe(false); // unverändert ⇒ kein Schreiben
    expect(readManifest(dir)).toEqual(m);
  });

  test('writeManifest dry-run schreibt nichts', () => {
    const dir = project({ name: 'x' });
    expect(writeManifest(dir, { ...emptyManifest(), harness: '1.0.0' }, true)).toBe(true);
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });

  test('beschädigtes Manifest wird als leer behandelt', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, MANIFEST_FILE), '{ kaputt');
    expect(readManifest(dir)).toEqual(emptyManifest());
  });

  test('korrupte (nicht-string) Einträge werden eintragsweise verworfen', () => {
    const dir = project({ name: 'x' });
    writeFileSync(
      join(dir, MANIFEST_FILE),
      JSON.stringify({ harness: 1, declined: [], files: { ok: 'abc', bad: null, n: 42 } })
    );
    const m = readManifest(dir);
    expect(m.harness).toBe(''); // nicht-string ⇒ Default
    expect(m.declined).toEqual({}); // Array ⇒ verworfen
    expect(m.files).toEqual({ ok: 'abc' }); // nur der String-Eintrag bleibt
  });
});

describe('capabilities', () => {
  test('Tabelle referenziert nur existierende Templates/Scripts/Deps', () => {
    // Svelte-Kontext, damit auch svelte-spezifische Scripts/Deps abgedeckt sind.
    const ctx = detectContext(project({ name: 'x', devDependencies: { svelte: '^5' } }));
    const fileIds = new Set(FILE_TEMPLATES.map((t) => t.id));
    const scriptNames = new Set(Object.keys(canonicalScripts(ctx)));
    const depNames = new Set(Object.keys(canonicalDevDeps(ctx)));
    for (const cap of CAPABILITIES) {
      for (const f of cap.files) expect(fileIds).toContain(f);
      for (const s of cap.scripts) expect(scriptNames).toContain(s);
      for (const d of cap.devDeps) {
        expect(VERSIONS[d]).toBeDefined();
        expect(depNames).toContain(d); // muss auch tatsächlich geplant werden
      }
    }
  });

  test('lint-format-Abwahl überspringt svelte-spezifische Lint/Format-Deps', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { svelte: '^5', eslint: '^9' } })
    );
    const sets = declinedSets(resolveCapabilities(ctx, emptyManifest()));
    const plan = computePkgPlan(ctx, { skip: { scripts: sets.scripts, devDeps: sets.devDeps } });
    expect(plan.devDepsToAdd.some((d) => d.name === 'svelte-check')).toBe(false);
    expect(plan.devDepsToAdd.some((d) => d.name === '@biomejs/biome')).toBe(false);
    // `prettier` bleibt (vom git-hooks-Prettier-Hook geteilt):
    expect(plan.devDepsToAdd.some((d) => d.name === 'prettier')).toBe(true);
  });

  test('veralteter Auto-Decline-Grund wird als stale markiert', () => {
    // husky einst erkannt und persistiert, jetzt aber weg ⇒ stale.
    const m: Manifest = { ...emptyManifest(), declined: { 'git-hooks': 'husky' } };
    const st = resolveCapabilities(detectContext(project({ name: 'x' })), m).find(
      (s) => s.cap.id === 'git-hooks'
    );
    expect(st?.stale).toBe(true);
  });

  test('manuelle Abwahl ist nie stale', () => {
    const m: Manifest = { ...emptyManifest(), declined: { 'git-hooks': 'manual' } };
    const st = resolveCapabilities(detectContext(project({ name: 'x' })), m).find(
      (s) => s.cap.id === 'git-hooks'
    );
    expect(st?.stale).toBe(false);
  });

  test('husky-Projekt wählt git-hooks automatisch ab (fresh)', () => {
    const ctx = detectContext(project({ name: 'x', devDependencies: { husky: '^9' } }));
    const st = resolveCapabilities(ctx, emptyManifest()).find((s) => s.cap.id === 'git-hooks');
    expect(st?.declined).toBe(true);
    expect(st?.reason).toBe('husky');
    expect(st?.fresh).toBe(true);
  });

  test('.husky-Verzeichnis löst Abwahl aus (ohne devDep)', () => {
    const dir = project({ name: 'x' });
    mkdirSync(join(dir, '.husky'));
    const st = resolveCapabilities(detectContext(dir), emptyManifest()).find(
      (s) => s.cap.id === 'git-hooks'
    );
    expect(st?.reason).toBe('husky');
  });

  test('eslint-Projekt wählt lint-format ab', () => {
    const ctx = detectContext(project({ name: 'x', devDependencies: { eslint: '^9' } }));
    const st = resolveCapabilities(ctx, emptyManifest()).find((s) => s.cap.id === 'lint-format');
    expect(st?.declined).toBe(true);
    expect(st?.reason).toBe('eslint');
  });

  test('persistierte Abwahl ist nicht fresh', () => {
    const ctx = detectContext(project({ name: 'x' }));
    const m: Manifest = { ...emptyManifest(), declined: { 'git-hooks': 'manual' } };
    const st = resolveCapabilities(ctx, m).find((s) => s.cap.id === 'git-hooks');
    expect(st).toMatchObject({ declined: true, reason: 'manual', fresh: false });
  });

  test('sauberes Projekt wählt nichts ab', () => {
    const states = resolveCapabilities(detectContext(project({ name: 'x' })), emptyManifest());
    expect(states.every((s) => !s.declined)).toBe(true);
  });

  test('declinedSets faltet Dateien/Scripts/devDeps zusammen', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { husky: '^9', eslint: '^9' } })
    );
    const sets = declinedSets(resolveCapabilities(ctx, emptyManifest()));
    expect(sets.files.get('lefthook')).toBe('husky');
    expect(sets.files.get('biome')).toBe('eslint');
    expect(sets.scripts.has('prepare')).toBe(true);
    expect(sets.devDeps.has('@biomejs/biome')).toBe(true);
  });

  test('abgewählte Capability-Datei wird in applyFiles übersprungen', () => {
    const dir = project({ name: 'x' });
    const res = applyFiles(
      dir,
      detectContext(dir),
      INIT,
      emptyManifest(),
      new Map([['lefthook', 'husky']])
    );
    expect(existsSync(join(dir, 'lefthook.yml'))).toBe(false);
    const r = res.find((x) => x.dest === 'lefthook.yml');
    expect(r?.action).toBe('skipped');
    expect(r?.note).toContain('husky');
  });

  test('computePkgPlan überspringt abgewählte Scripts/devDeps (skip)', () => {
    const ctx = detectContext(project({ name: 'x' }));
    const plan = computePkgPlan(ctx, {
      skip: { scripts: new Set(['prepare']), devDeps: new Set(['lefthook']) }
    });
    expect(plan.scriptsToAdd.some((s) => s.name === 'prepare')).toBe(false);
    expect(plan.devDepsToAdd.some((d) => d.name === 'lefthook')).toBe(false);
  });

  test('computePkgPlan only-Whitelist beschränkt den Plan', () => {
    const ctx = detectContext(project({ name: 'x' }));
    const plan = computePkgPlan(ctx, {
      only: { scripts: new Set(['lint']), devDeps: new Set(['@biomejs/biome']) }
    });
    expect(plan.scriptsToAdd.map((s) => s.name)).toEqual(['lint']);
    expect(plan.devDepsToAdd.map((d) => d.name)).toEqual(['@biomejs/biome']);
  });
});

describe('resolveSelection (--only)', () => {
  const fileIds = new Set(FILE_TEMPLATES.map((t) => t.id));

  test('Capability-Id expandiert zu Datei/Scripts/devDeps', () => {
    const sel = resolveSelection(['git-hooks'], fileIds);
    expect(sel.files.has('lefthook')).toBe(true);
    expect(sel.scripts.has('prepare')).toBe(true);
    expect(sel.devDeps.has('lefthook')).toBe(true);
    expect(sel.unknown).toHaveLength(0);
  });

  test('Datei-Id wird direkt übernommen', () => {
    const sel = resolveSelection(['cliff'], fileIds);
    expect(sel.files.has('cliff')).toBe(true);
    expect(sel.scripts.size).toBe(0);
  });

  test('unbekannte Bezeichner landen in unknown', () => {
    const sel = resolveSelection(['cliff', 'unsinn'], fileIds);
    expect(sel.files.has('cliff')).toBe(true);
    expect(sel.unknown).toEqual(['unsinn']);
  });
});

describe('applyFiles --only', () => {
  test('beschränkt das Schreiben auf die gewählten Datei-Ids', () => {
    const dir = project({ name: 'x' });
    const res = applyFiles(
      dir,
      detectContext(dir),
      INIT,
      emptyManifest(),
      new Map(),
      new Set(['cliff'])
    );
    expect(existsSync(join(dir, 'cliff.toml'))).toBe(true);
    expect(existsSync(join(dir, 'biome.json'))).toBe(false); // nicht im Filter
    expect(res.every((r) => r.dest === 'cliff.toml')).toBe(true);
  });

  test('only + force schreibt gezielt nur eine lokal geänderte Datei (interaktiver Pfad)', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    const m = emptyManifest();
    applyFiles(dir, ctx, INIT, m); // legt cliff.toml + bump.sh an
    writeFileSync(join(dir, 'cliff.toml'), '# lokal');
    writeFileSync(join(dir, 'scripts/bump.sh'), '# lokal bump');
    // gezieltes Force-Write nur für cliff (wie runInteractive bei "update"):
    applyFiles(dir, ctx, { ...SYNC, force: true }, m, new Map(), new Set(['cliff']));
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).not.toBe('# lokal');
    expect(readFileSync(join(dir, 'scripts/bump.sh'), 'utf8')).toBe('# lokal bump'); // unberührt
  });
});

describe('skip & adopt', () => {
  test('skip persistiert manuelle Abwahl, adopt nimmt sie zurück', () => {
    const dir = project({ name: 'x' });
    expect(runSkip({ cwd: dir, dryRun: false, capability: 'git-hooks' })).toBe(0);
    expect(readManifest(dir).declined['git-hooks']).toBe('manual');
    expect(runAdopt({ cwd: dir, dryRun: false, capability: 'git-hooks' })).toBe(0);
    expect(readManifest(dir).declined['git-hooks']).toBeUndefined();
  });

  test('adopt überstimmt Auto-Abwahl (lefthook trotz husky)', () => {
    // husky vorhanden ⇒ git-hooks würde auto-abgewählt; adopt macht es explizit aktiv.
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    expect(runAdopt({ cwd: dir, dryRun: false, capability: 'git-hooks' })).toBe(0);
    const m = readManifest(dir);
    expect(m.adopted).toContain('git-hooks');
    expect(m.declined['git-hooks']).toBeUndefined();
    // resolveCapabilities respektiert adopt trotz weiterhin vorhandenem husky:
    const st = resolveCapabilities(detectContext(dir), m).find((s) => s.cap.id === 'git-hooks');
    expect(st?.declined).toBe(false);
  });

  test('skip hebt eine vorherige Aufnahme (adopt) wieder auf', () => {
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    runAdopt({ cwd: dir, dryRun: false, capability: 'git-hooks' });
    runSkip({ cwd: dir, dryRun: false, capability: 'git-hooks' });
    const m = readManifest(dir);
    expect(m.adopted).not.toContain('git-hooks');
    expect(m.declined['git-hooks']).toBe('manual');
  });

  test('unbekannter Baustein → exit 2', () => {
    const dir = project({ name: 'x' });
    expect(runSkip({ cwd: dir, dryRun: false, capability: 'unsinn' })).toBe(2);
  });

  test('fehlender Baustein-Name → exit 2', () => {
    const dir = project({ name: 'x' });
    expect(runAdopt({ cwd: dir, dryRun: false, capability: undefined })).toBe(2);
  });

  test('skip --dry-run schreibt kein Manifest', () => {
    const dir = project({ name: 'x' });
    runSkip({ cwd: dir, dryRun: true, capability: 'git-hooks' });
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });
});

describe('add (Dev-facing = adopt + gezielter sync)', () => {
  const addFlags = (cwd: string, dryRun: boolean, capability: string | undefined) => ({
    ...HARNESS_DEFAULTS,
    cwd,
    dryRun,
    capability
  });

  test('richtet einen Baustein direkt ein (Datei + Script + devDep), chirurgisch', () => {
    const dir = project({ name: 'x' });
    expect(runAdd(addFlags(dir, false, 'git-hooks'))).toBe(0);
    expect(existsSync(join(dir, 'lefthook.yml'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts?.prepare).toBe('lefthook install');
    expect(pkg.devDependencies?.lefthook).toBeDefined();
    // nur dieser Baustein — andere bleiben unberührt:
    expect(existsSync(join(dir, 'biome.json'))).toBe(false);
    expect(pkg.scripts?.bump).toBeUndefined();
    expect(readManifest(dir).adopted).toContain('git-hooks');
  });

  test('überstimmt die Auto-Abwahl (lefthook trotz husky) und richtet ein', () => {
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    expect(runAdd(addFlags(dir, false, 'git-hooks'))).toBe(0);
    expect(existsSync(join(dir, 'lefthook.yml'))).toBe(true);
    const m = readManifest(dir);
    expect(m.adopted).toContain('git-hooks');
    expect(m.declined['git-hooks']).toBeUndefined();
  });

  test('dry-run schreibt nichts — weder Datei noch Manifest', () => {
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    expect(runAdd(addFlags(dir, true, 'git-hooks'))).toBe(0);
    expect(existsSync(join(dir, 'lefthook.yml'))).toBe(false);
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });

  test('unbekannter Baustein → exit 2, nichts geschrieben', () => {
    const dir = project({ name: 'x' });
    expect(runAdd(addFlags(dir, false, 'unsinn'))).toBe(2);
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });

  test('fehlender Baustein-Name → exit 2', () => {
    const dir = project({ name: 'x' });
    expect(runAdd(addFlags(dir, false, undefined))).toBe(2);
  });

  test('add --force überschreibt eine vorhandene create-only-Config NICHT (additiv)', () => {
    // eslint ⇒ lint-format auto-abgewählt; add nimmt es auf, lässt aber die eigene biome.json.
    const dir = project({ name: 'x', devDependencies: { eslint: '^9' } });
    writeFileSync(join(dir, 'biome.json'), '{"custom":true}');
    expect(
      runAdd({
        ...HARNESS_DEFAULTS,
        cwd: dir,
        dryRun: false,
        force: true,
        capability: 'lint-format'
      })
    ).toBe(0);
    expect(readFileSync(join(dir, 'biome.json'), 'utf8')).toBe('{"custom":true}');
  });
});

describe('installPlan (--install Entscheidung)', () => {
  test('Änderungen + --install → ausführen, nicht anbieten', () => {
    expect(installPlan({ install: true, dryRun: false }, true)).toEqual({
      run: true,
      offer: false
    });
  });

  test('Änderungen ohne --install → anbieten, nicht ausführen', () => {
    expect(installPlan({ install: false, dryRun: false }, true)).toEqual({
      run: false,
      offer: true
    });
  });

  test('keine installierbaren Änderungen → weder ausführen noch anbieten', () => {
    expect(installPlan({ install: true, dryRun: false }, false)).toEqual({
      run: false,
      offer: false
    });
    expect(installPlan({ install: false, dryRun: false }, false)).toEqual({
      run: false,
      offer: false
    });
  });

  test('Dry-Run führt nie aus und bietet nicht an (auch mit --install + Änderungen)', () => {
    expect(installPlan({ install: true, dryRun: true }, true)).toEqual({
      run: false,
      offer: false
    });
  });
});

describe('runHarness Orchestrierung', () => {
  test('persistiert frische Auto-Abwahl ins Manifest (ohne --only)', () => {
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(readManifest(dir).declined['git-hooks']).toBe('husky');
    expect(existsSync(join(dir, 'lefthook.yml'))).toBe(false);
    // beim Folgelauf nicht mehr 'fresh', sondern persistiert:
    const st = resolveCapabilities(detectContext(dir), readManifest(dir)).find(
      (s) => s.cap.id === 'git-hooks'
    );
    expect(st).toMatchObject({ declined: true, fresh: false });
  });

  test('dry-run persistiert keine Auto-Abwahl (kein Manifest)', () => {
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: true });
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });

  test('--only persistiert keine Auto-Abwahl (chirurgisch, keine stille Mutation)', () => {
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false, only: ['cliff'] });
    expect(readManifest(dir).declined['git-hooks']).toBeUndefined();
  });

  test('--only git-hooks patcht nur dessen Script/devDep (chirurgisch)', () => {
    const dir = project({ name: 'x' });
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false, only: ['git-hooks'] });
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts?.prepare).toBe('lefthook install');
    expect(pkg.devDependencies?.lefthook).toBeDefined();
    expect(pkg.scripts?.bump).toBeUndefined();
    expect(pkg.devDependencies?.['@biomejs/biome']).toBeUndefined();
    expect(existsSync(join(dir, 'biome.json'))).toBe(false);
  });

  test('--only ohne Treffer im Monorepo schreibt nichts (root + package aggregiert)', () => {
    const dir = monorepo();
    const code = runHarness('init', {
      ...HARNESS_DEFAULTS,
      cwd: dir,
      dryRun: false,
      only: ['unsinn']
    });
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'packages/api/tsconfig.json'))).toBe(false);
    expect(existsSync(join(dir, 'cliff.toml'))).toBe(false);
  });

  test('--only auf auto-abgewähltem Baustein bleibt ohne Aufnahme übersprungen', () => {
    // husky ⇒ git-hooks wird auto-abgewählt; ein gezielter sync allein richtet es NICHT ein.
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false, only: ['git-hooks'] });
    expect(existsSync(join(dir, 'lefthook.yml'))).toBe(false);
  });

  test('manifestOverride hebt die Auto-Abwahl im sync auf (Fundament von runAdd)', () => {
    // Das ist genau der Pfad, über den `udx add` die Aufnahme auch im Dry-Run sichtbar macht.
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    const m: Manifest = { ...emptyManifest(), adopted: ['git-hooks'] };
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false, only: ['git-hooks'] }, m);
    expect(existsSync(join(dir, 'lefthook.yml'))).toBe(true);
    // die Aufnahme wird vom sync persistiert:
    expect(readManifest(dir).adopted).toContain('git-hooks');
  });
});

describe('Per-Paket-Svelte-Tier (D9 WP1)', () => {
  const readPkg = (dir: string, rel = 'package.json') =>
    JSON.parse(readFileSync(join(dir, rel), 'utf8'));

  test('Svelte-Sub-Paket bekommt Svelte-Deps + svelte-flavored Scripts (schließt den Gap)', () => {
    const dir = monorepo(); // nicht-svelte Root, packages/ui = svelte
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const ui = readPkg(dir, 'packages/ui/package.json');
    for (const d of SVELTE_DEPS) expect(ui.devDependencies?.[d]).toBeDefined();
    expect(ui.scripts?.lint).toBe('biome check . && svelte-check --tsconfig ./tsconfig.json');
    expect(ui.scripts?.format).toBe('biome format --write . && prettier --write "**/*.svelte"');
    // Repo-globale Scripts gehören NICHT ins Paket (laufen einmal im Root):
    expect(ui.scripts?.bump).toBeUndefined();
    expect(ui.scripts?.prepare).toBeUndefined();
    expect(ui.scripts?.fix).toBeUndefined();
  });

  test('Root behält nicht-svelte Lint/Format und bekommt keine Svelte-Deps', () => {
    const dir = monorepo();
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const root = readPkg(dir);
    expect(root.scripts?.lint).toBe('biome check .');
    expect(root.scripts?.format).toBe('biome format --write .');
    expect(root.scripts?.bump).toBe('bash scripts/bump.sh patch'); // repo-global im Root
    expect(root.devDependencies?.['@biomejs/biome']).toBeDefined();
    for (const d of SVELTE_DEPS) expect(root.devDependencies?.[d]).toBeUndefined();
  });

  test('Nicht-svelte-TS-Paket bekommt keine eigenen devDeps (Decision A, Hoisting)', () => {
    const dir = monorepo();
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const api = readPkg(dir, 'packages/api/package.json'); // TS (src/), nicht svelte
    expect(api.devDependencies).toBeUndefined();
    // ... bekommt aber die package-scoped tsconfig (bestehendes Verhalten):
    expect(existsSync(join(dir, 'packages/api/tsconfig.json'))).toBe(true);
  });

  test('zweiter sync ist idempotent (kein erneuter Svelte-Paket-Drift)', () => {
    const dir = monorepo();
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const before = readFileSync(join(dir, 'packages/ui/package.json'), 'utf8');
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(readFileSync(join(dir, 'packages/ui/package.json'), 'utf8')).toBe(before);
  });

  test('canonicalDevDeps/Scripts respektieren das Tier', () => {
    const svelteCtx = detectContext(project({ name: 'u', devDependencies: { svelte: '^5' } }));
    const plainCtx = detectContext(project({ name: 'p' }));
    // svelte-Tier: nur Svelte-Deps, und nur bei Svelte-Kontext
    expect(Object.keys(canonicalDevDeps(svelteCtx, 'svelte')).sort()).toEqual(
      [...SVELTE_DEPS].sort()
    );
    expect(canonicalDevDeps(plainCtx, 'svelte')).toEqual({});
    // root-Tier: nie Svelte
    for (const d of SVELTE_DEPS) expect(canonicalDevDeps(svelteCtx, 'root')[d]).toBeUndefined();
    expect(canonicalDevDeps(svelteCtx, 'root')['@biomejs/biome']).toBeDefined();
    // kein Tier = bisheriges Verhalten (Svelte inklusive)
    for (const d of SVELTE_DEPS) expect(canonicalDevDeps(svelteCtx)[d]).toBeDefined();
    // Scripts
    expect(canonicalScripts(svelteCtx, 'svelte')).toEqual({
      format: 'biome format --write . && prettier --write "**/*.svelte"',
      lint: 'biome check . && svelte-check --tsconfig ./tsconfig.json'
    });
    expect(canonicalScripts(plainCtx, 'svelte')).toEqual({});
    expect(canonicalScripts(plainCtx, 'root').lint).toBe('biome check .');
    expect(canonicalScripts(plainCtx, 'root').prepare).toBe('lefthook install');
  });
});

describe('Catalog-Modell (D9 WP2)', () => {
  test('readCatalogTables: Objekt-Form mit catalog → Tabellen', () => {
    const t = readCatalogTables({ workspaces: { catalog: { '@biomejs/biome': '^2.4.0' } } });
    expect(t?.default['@biomejs/biome']).toBe('^2.4.0');
    expect(t?.named).toEqual({});
  });

  test('readCatalogTables: Array-Form → null (kein catalog: möglich)', () => {
    expect(readCatalogTables({ workspaces: ['packages/*'] })).toBeNull();
  });

  test('readCatalogTables: Objekt-Form ohne catalog/catalogs → null (kein Catalog-First)', () => {
    expect(readCatalogTables({ workspaces: { packages: ['packages/*'] } })).toBeNull();
  });

  test('readCatalogTables: kein workspaces → null', () => {
    expect(readCatalogTables({ name: 'x' })).toBeNull();
  });

  test('readCatalogTables: benannte Catalogs', () => {
    const t = readCatalogTables({
      workspaces: { catalogs: { svelte: { 'svelte-check': '^4.0.0' } } }
    });
    expect(t?.named.svelte?.['svelte-check']).toBe('^4.0.0');
    expect(t?.default).toEqual({});
  });

  test('selectCatalogTable: Default-Treffer / named-Treffer / nirgends', () => {
    expect(selectCatalogTable({ default: { biome: '^2.0.0' }, named: {} }, 'biome')).toEqual({
      table: null,
      ref: 'catalog:',
      current: '^2.0.0'
    });
    expect(
      selectCatalogTable(
        { default: {}, named: { svelte: { 'svelte-check': '^4.0.0' } } },
        'svelte-check'
      )
    ).toEqual({ table: 'svelte', ref: 'catalog:svelte', current: '^4.0.0' });
    expect(selectCatalogTable({ default: {}, named: {} }, 'neu')).toEqual({
      table: null,
      ref: 'catalog:',
      current: undefined
    });
  });

  test('raise: operator-erhaltend, Floor-Maximum, nie Downgrade', () => {
    expect(raise('^2.3.0', '^2.4.16')).toBe('^2.4.16'); // hochgezogen, ^ bleibt
    expect(raise('^2.5.0', '^2.4.16')).toBe('^2.5.0'); // current höher → bleibt (kein Downgrade)
    expect(raise('~1.2.0', '^1.5.0')).toBe('~1.5.0'); // ~ bleibt erhalten
    expect(raise('>=2.0.0', '^3.0.0')).toBe('>=3.0.0'); // >= bleibt erhalten
    expect(raise('^1.0.0', '^1.0.0')).toBe('^1.0.0'); // idempotent (gleicher Floor)
    expect(raise('catalog:', '^1.0.0')).toBe('catalog:'); // Protokoll → unverändert
    expect(raise('*', '^1.0.0')).toBe('*'); // nicht vergleichbar → unverändert
    expect(raise('^1.2.3+build.5', '^1.0.0')).toBe('^1.2.3+build.5'); // höher → unverändert (Build-Meta bleibt)
    // Compound-/führende-`<`-Ranges sind nicht eindeutig anhebbar → sauber den (Pin-)target nutzen:
    expect(raise('>=2.0.0 <3.0.0', '^3.5.0')).toBe('^3.5.0');
    expect(raise('<3.0.0 >=2.0.0', '^2.5.0')).toBe('^2.5.0');
  });
});

describe('computePkgPlan Catalog-Modus (D9 WP2)', () => {
  const biome = VERSIONS['@biomejs/biome']; // Pin, per Konvention `^x.y.z`
  const only = (dep: string) => ({ only: { devDeps: new Set([dep]) } });
  const empty = { default: {}, named: {} };

  test('fehlender Eintrag: legt Catalog-Eintrag an + stellt devDep auf catalog: um', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@biomejs/biome': '^2.3.0' } })
    );
    const plan = computePkgPlan(ctx, only('@biomejs/biome'), undefined, empty);
    expect(plan.catalogEntriesToAdd).toEqual([{ name: '@biomejs/biome', table: null, to: biome }]);
    expect(plan.devDepsToCatalog).toEqual([
      { name: '@biomejs/biome', from: '^2.3.0', to: 'catalog:' }
    ]);
    expect(plan.devDepsDrift).toEqual([]); // kein literaler Drift im Catalog-Modus
  });

  test('aktueller Eintrag, literale devDep → nur Switch, kein Drift', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@biomejs/biome': '^2.4.16' } })
    );
    const plan = computePkgPlan(ctx, only('@biomejs/biome'), undefined, {
      default: { '@biomejs/biome': biome },
      named: {}
    });
    expect(plan.catalogEntriesToAdd).toEqual([]);
    expect(plan.catalogEntriesDrift).toEqual([]);
    expect(plan.devDepsToCatalog).toEqual([
      { name: '@biomejs/biome', from: '^2.4.16', to: 'catalog:' }
    ]);
  });

  test('Eintrag hinter Pin → Drift hebt an (devDep schon catalog:)', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@biomejs/biome': 'catalog:' } })
    );
    const plan = computePkgPlan(ctx, only('@biomejs/biome'), undefined, {
      default: { '@biomejs/biome': '^2.0.0' },
      named: {}
    });
    expect(plan.catalogEntriesDrift).toEqual([
      { name: '@biomejs/biome', table: null, from: '^2.0.0', to: biome }
    ]);
    expect(plan.devDepsToCatalog).toEqual([]); // devDep schon korrekt
  });

  test('Eintrag neuer als Pin → kein Drift', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@biomejs/biome': 'catalog:' } })
    );
    const plan = computePkgPlan(ctx, only('@biomejs/biome'), undefined, {
      default: { '@biomejs/biome': '^99.0.0' },
      named: {}
    });
    expect(plan.catalogEntriesDrift).toEqual([]);
    expect(plan.catalogEntriesToAdd).toEqual([]);
  });

  test('@urbicon/* bleiben literal (nie in den Catalog)', () => {
    const ctx = detectContext(project({ name: 'x' }));
    const plan = computePkgPlan(ctx, only('@urbicon/tsconfig'), undefined, empty);
    expect(plan.catalogEntriesToAdd).toEqual([]);
    expect(plan.devDepsToCatalog).toEqual([]);
    expect(plan.devDepsToAdd).toEqual([
      { name: '@urbicon/tsconfig', to: VERSIONS['@urbicon/tsconfig'] }
    ]);
  });

  test('gepinnter Dep: kein Switch, kein Eintrag, nur gehalten gemeldet', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@biomejs/biome': '^2.3.0' } })
    );
    const plan = computePkgPlan(
      ctx,
      { ...only('@biomejs/biome'), pinned: new Set(['@biomejs/biome']) },
      undefined,
      empty
    );
    expect(plan.devDepsPinned.map((c) => c.name)).toContain('@biomejs/biome');
    expect(plan.catalogEntriesToAdd).toEqual([]);
    expect(plan.devDepsToCatalog).toEqual([]);
  });

  test('literale devDep neuer als Pin, Eintrag fehlt → Eintrag = Maximum (kein Downgrade, D9-E)', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@biomejs/biome': '^99.0.0' } })
    );
    const plan = computePkgPlan(ctx, only('@biomejs/biome'), undefined, empty);
    expect(plan.catalogEntriesToAdd).toEqual([
      { name: '@biomejs/biome', table: null, to: '^99.0.0' }
    ]);
    expect(plan.devDepsToCatalog).toEqual([
      { name: '@biomejs/biome', from: '^99.0.0', to: 'catalog:' }
    ]);
  });

  test('benannter Catalog (catalogs.svelte) wird genutzt statt des Defaults', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { svelte: '^5', 'svelte-check': '^4.0.0' } })
    );
    const plan = computePkgPlan(ctx, only('svelte-check'), undefined, {
      default: {},
      named: { svelte: { 'svelte-check': '^4.0.0' } }
    });
    expect(plan.devDepsToCatalog).toEqual([
      { name: 'svelte-check', from: '^4.0.0', to: 'catalog:svelte' }
    ]);
    expect(plan.catalogEntriesToAdd).toEqual([]); // schon im benannten Catalog
  });

  test('devDep catalog: aber Eintrag fehlt → Eintrag wird ergänzt (repariert kaputten Zustand)', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@biomejs/biome': 'catalog:' } })
    );
    const plan = computePkgPlan(ctx, only('@biomejs/biome'), undefined, empty);
    expect(plan.catalogEntriesToAdd).toEqual([{ name: '@biomejs/biome', table: null, to: biome }]);
    expect(plan.devDepsToCatalog).toEqual([]);
    expect(plan.devDepsToAdd).toEqual([]);
  });

  test('Eintrag älter als literale devDep → Drift aufs Maximum + Switch gleichzeitig (D9-E)', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@biomejs/biome': '^2.6.0' } })
    );
    const plan = computePkgPlan(ctx, only('@biomejs/biome'), undefined, {
      default: { '@biomejs/biome': '^2.0.0' },
      named: {}
    });
    // Eintrag ^2.0.0 hinter Pin UND hinter der literalen devDep ^2.6.0 → auf das Maximum heben.
    expect(plan.catalogEntriesDrift).toEqual([
      { name: '@biomejs/biome', table: null, from: '^2.0.0', to: '^2.6.0' }
    ]);
    expect(plan.devDepsToCatalog).toEqual([
      { name: '@biomejs/biome', from: '^2.6.0', to: 'catalog:' }
    ]);
  });

  test('Invariante: jeder catalog:-devDep im Plan hat einen vorhandenen/geplanten Eintrag', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@biomejs/biome': '^2.3.0', lefthook: 'catalog:' } })
    );
    const plan = computePkgPlan(ctx, {}, 'root', empty);
    const planned = new Set(plan.catalogEntriesToAdd.map((c) => c.name));
    const switched = [
      ...plan.devDepsToCatalog,
      ...plan.devDepsToAdd.filter((c) => c.to.startsWith('catalog:'))
    ];
    for (const ch of switched) expect(planned.has(ch.name)).toBe(true);
  });
});

describe('Catalog-Writes via runHarness (D9 WP3)', () => {
  const readPkg = (dir: string, rel = 'package.json') =>
    JSON.parse(readFileSync(join(dir, rel), 'utf8'));

  test('Catalog-Monorepo init: Root führt Tool-Deps als catalog: + pflegt die Einträge', () => {
    const dir = monorepo(true, {}); // leerer Default-Catalog ⇒ Catalog-Modus
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const root = readPkg(dir);
    expect(root.devDependencies['@biomejs/biome']).toBe('catalog:');
    expect(root.devDependencies.typescript).toBe('catalog:');
    expect(root.workspaces.catalog['@biomejs/biome']).toBe(VERSIONS['@biomejs/biome']);
    expect(root.workspaces.catalog.typescript).toBe(VERSIONS.typescript);
    // @urbicon/* bleiben literal (D9-D), nie im Catalog:
    expect(root.devDependencies['@urbicon/tsconfig']).toBe(VERSIONS['@urbicon/tsconfig']);
    expect(root.workspaces.catalog['@urbicon/tsconfig']).toBeUndefined();
    // workspaces.packages bleibt intakt:
    expect(root.workspaces.packages).toEqual(['packages/*']);
  });

  test('Atomarität: jeder catalog:-devDep hat einen Catalog-Eintrag (bun install würde auflösen)', () => {
    const dir = monorepo(true, {});
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const root = readPkg(dir);
    const cat: Record<string, string> = root.workspaces.catalog ?? {};
    const named: Record<string, Record<string, string>> = root.workspaces.catalogs ?? {};
    for (const p of [root, readPkg(dir, 'packages/ui/package.json')]) {
      for (const [name, spec] of Object.entries(p.devDependencies ?? {})) {
        if (spec === 'catalog:') expect(cat[name]).toBeDefined();
        else if (typeof spec === 'string' && spec.startsWith('catalog:'))
          expect(named[spec.slice('catalog:'.length)]?.[name]).toBeDefined();
      }
    }
  });

  test('Svelte-Paket führt Svelte-Deps als catalog:, Eintrag im Root-Catalog; api ohne devDeps', () => {
    const dir = monorepo(true, {});
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(readPkg(dir, 'packages/ui/package.json').devDependencies['svelte-check']).toBe(
      'catalog:'
    );
    expect(readPkg(dir).workspaces.catalog['svelte-check']).toBe(VERSIONS['svelte-check']);
    expect(readPkg(dir, 'packages/api/package.json').devDependencies).toBeUndefined(); // Decision A
  });

  test('zwei Svelte-Pakete, unterschiedliche Versionen → Catalog = Maximum, kein Downgrade', () => {
    const dir = monorepo(true, {});
    writeFileSync(
      join(dir, 'packages/ui/package.json'),
      JSON.stringify({ name: 'ui', devDependencies: { svelte: '^5', 'svelte-check': '^4.0.0' } })
    );
    mkdirSync(join(dir, 'packages/admin'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/admin/package.json'),
      JSON.stringify({
        name: 'admin',
        devDependencies: { svelte: '^5', 'svelte-check': '^99.0.0' }
      })
    );
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    // Catalog = Maximum über beide Pakete (^99.0.0) — kein Downgrade für admin:
    expect(readPkg(dir).workspaces.catalog['svelte-check']).toBe('^99.0.0');
    expect(readPkg(dir, 'packages/ui/package.json').devDependencies['svelte-check']).toBe(
      'catalog:'
    );
    expect(readPkg(dir, 'packages/admin/package.json').devDependencies['svelte-check']).toBe(
      'catalog:'
    );
  });

  test('Single-Package mit Catalog: devDeps → catalog:, Einträge gepflegt', () => {
    const dir = project({
      name: 'solo',
      workspaces: { catalog: {} },
      devDependencies: { '@biomejs/biome': '^2.0.0' }
    });
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const pkg = readPkg(dir);
    expect(pkg.devDependencies['@biomejs/biome']).toBe('catalog:');
    expect(pkg.workspaces.catalog['@biomejs/biome']).toBe(VERSIONS['@biomejs/biome']);
  });

  test('dry-run im Catalog-Modus schreibt nichts', () => {
    const dir = monorepo(true, {});
    const before = readFileSync(join(dir, 'package.json'), 'utf8');
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: true });
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before);
  });

  test('zweiter sync ist idempotent (Catalog-Modus, Root + Paket)', () => {
    const dir = monorepo(true, {});
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const before = readFileSync(join(dir, 'package.json'), 'utf8');
    const beforeUi = readFileSync(join(dir, 'packages/ui/package.json'), 'utf8');
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before);
    expect(readFileSync(join(dir, 'packages/ui/package.json'), 'utf8')).toBe(beforeUi);
  });

  test('Array-Form-Monorepo bleibt literal (kein Catalog möglich), Gap trotzdem geschlossen', () => {
    const dir = monorepo(); // Array-Form, kein Catalog
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const root = readPkg(dir);
    expect(root.devDependencies['@biomejs/biome']).toBe(VERSIONS['@biomejs/biome']); // literal
    expect(root.workspaces.catalog).toBeUndefined();
    expect(readPkg(dir, 'packages/ui/package.json').devDependencies['svelte-check']).toBe(
      VERSIONS['svelte-check']
    ); // literal je Paket → Gap geschlossen ohne Catalog
  });

  test('benannter Consumer-Catalog wird genutzt (catalog:svelte); fremde Einträge bleiben', () => {
    const dir = mkdtempSync(join(tmpdir(), 'udx-named-'));
    // Default-Catalog mit einem unmanaged Eintrag (react) + benannter svelte-Catalog (svelte-check).
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'root',
        workspaces: {
          packages: ['packages/*'],
          catalog: { react: '^18.0.0' },
          catalogs: { svelte: { 'svelte-check': '^4.0.0' } }
        }
      })
    );
    mkdirSync(join(dir, 'packages/ui'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/ui/package.json'),
      JSON.stringify({ name: 'ui', devDependencies: { svelte: '^5' } })
    );
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const root = readPkg(dir);
    // svelte-check wird im BENANNTEN Catalog gepflegt (nicht in den Default verschoben):
    expect(root.workspaces.catalogs.svelte['svelte-check']).toBe(VERSIONS['svelte-check']);
    expect(root.workspaces.catalog['svelte-check']).toBeUndefined();
    expect(readPkg(dir, 'packages/ui/package.json').devDependencies['svelte-check']).toBe(
      'catalog:svelte'
    );
    // Fremder, unmanaged Eintrag bleibt unberührt:
    expect(root.workspaces.catalog.react).toBe('^18.0.0');
  });

  test('gepinnter Dep bleibt im Catalog-Modus literal (kein Switch, kein Catalog-Eintrag)', () => {
    const dir = monorepo(true, {});
    writeFileSync(
      join(dir, '.udx.json'),
      JSON.stringify({ ...emptyManifest(), pinned: { '@biomejs/biome': '^2.0.0' } })
    );
    const root0 = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    root0.devDependencies = { '@biomejs/biome': '^2.0.0' };
    writeFileSync(join(dir, 'package.json'), JSON.stringify(root0));
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const root = readPkg(dir);
    expect(root.devDependencies['@biomejs/biome']).toBe('^2.0.0'); // gehalten, nicht catalog:
    expect(root.workspaces.catalog['@biomejs/biome']).toBeUndefined(); // kein Eintrag
    expect(root.devDependencies.typescript).toBe('catalog:'); // ungepinnter Tool-Dep ist catalog:
  });
});

describe('computePkgPlan', () => {
  test('fehlende Scripts & devDeps werden geplant', () => {
    const plan = computePkgPlan(detectContext(project({ name: 'x' })));
    expect(plan.scriptsToAdd.some((s) => s.name === 'bump')).toBe(true);
    expect(plan.devDepsToAdd.some((d) => d.name === '@biomejs/biome')).toBe(true);
  });

  test('vorhandenes Script mit anderem Wert = Drift', () => {
    const plan = computePkgPlan(
      detectContext(project({ name: 'x', scripts: { lint: 'eslint .' } }))
    );
    expect(plan.scriptsDrift.some((s) => s.name === 'lint')).toBe(true);
  });

  test('svelte plant svelte-check + prettier-Deps', () => {
    const plan = computePkgPlan(
      detectContext(project({ name: 'x', devDependencies: { svelte: '^5' } }))
    );
    expect(plan.devDepsToAdd.some((d) => d.name === 'svelte-check')).toBe(true);
    expect(plan.devDepsToAdd.some((d) => d.name === 'prettier-plugin-svelte')).toBe(true);
  });

  test('workspace:* devDep gilt als erfüllt (kein Drift)', () => {
    const plan = computePkgPlan(
      detectContext(project({ name: 'x', devDependencies: { '@biomejs/biome': 'workspace:*' } }))
    );
    expect(plan.devDepsToAdd.some((d) => d.name === '@biomejs/biome')).toBe(false);
    expect(plan.devDepsDrift.some((d) => d.name === '@biomejs/biome')).toBe(false);
  });

  test('neuere kompatible devDep-Version ist kein Drift (kein Downgrade)', () => {
    // Eine höhere Patch-Version als der Pin erfüllt die Baseline ⇒ udx fasst sie nicht an.
    const [maj, min, patch] = VERSIONS['@types/node'].replace('^', '').split('.').map(Number);
    const newer = `^${maj}.${min}.${(patch as number) + 1}`;
    const plan = computePkgPlan(
      detectContext(project({ name: 'x', devDependencies: { '@types/node': newer } }))
    );
    expect(plan.devDepsToAdd.some((d) => d.name === '@types/node')).toBe(false);
    expect(plan.devDepsDrift.some((d) => d.name === '@types/node')).toBe(false);
  });

  test('ältere devDep-Version ist Drift (Projekt liegt hinter dem Pin)', () => {
    const plan = computePkgPlan(
      detectContext(project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } }))
    );
    expect(plan.devDepsDrift.some((d) => d.name === '@types/node')).toBe(true);
  });
});

describe('satisfiesPin', () => {
  test('neuere kompatible Version erfüllt den Pin (kein Downgrade)', () => {
    expect(satisfiesPin('^25.9.2', '^25.9.1')).toBe(true);
    expect(satisfiesPin('^26.0.0', '^25.9.1')).toBe(true); // höhere Major bleibt unberührt
  });

  test('gleicher Floor erfüllt den Pin', () => {
    expect(satisfiesPin('^0.1.4', '^0.1.4')).toBe(true);
  });

  test('ältere Version erfüllt den Pin nicht (= Drift)', () => {
    expect(satisfiesPin('^0.1.2', '^0.1.4')).toBe(false);
    expect(satisfiesPin('~1.2.3', '^1.3.0')).toBe(false);
  });

  test('workspace:/catalog: gelten als erfüllt (Version anderswo geregelt)', () => {
    expect(satisfiesPin('workspace:*', '^2.4.16')).toBe(true);
    expect(satisfiesPin('catalog:', '^25.9.1')).toBe(true);
  });

  test('nicht vergleichbare Range gilt als erfüllt (kein riskantes Downgrade)', () => {
    expect(satisfiesPin('github:foo/bar', '^1.0.0')).toBe(true);
    expect(satisfiesPin('*', '^1.0.0')).toBe(true);
  });

  test('compound-Range nutzt den Floor, unabhängig von der Token-Reihenfolge', () => {
    expect(satisfiesPin('>=2.0.0 <3.0.0', '^2.5.0')).toBe(false); // Floor 2.0.0 < Pin
    expect(satisfiesPin('<3.0.0 >=2.0.0', '^2.5.0')).toBe(false); // Obergrenze zuerst → trotzdem 2.0.0
    expect(satisfiesPin('>=2.6.0 <3.0.0', '^2.5.0')).toBe(true); // Floor 2.6.0 ≥ Pin
  });

  test('tilde-Range mit gleichem Floor erfüllt den Pin', () => {
    expect(satisfiesPin('~1.3.0', '^1.3.0')).toBe(true);
  });

  test('npm:-Alias / git-URL mit eingebetteter Version gelten als erfüllt (anderes Paket)', () => {
    expect(satisfiesPin('npm:@biomejs/biome@^2.5.0', '^2.4.16')).toBe(true);
    expect(satisfiesPin('git+https://x/y#v1.0.0', '^9.9.9')).toBe(true);
  });
});

describe('mutatePkg', () => {
  test('ergänzt fehlende Scripts/devDeps und sortiert devDeps alphabetisch', () => {
    const ctx = detectContext(project({ name: 'x' }));
    const changed = mutatePkg(ctx.pkg, computePkgPlan(ctx), false);
    expect(changed).toBe(true);
    expect(ctx.pkg.scripts?.bump).toBe('bash scripts/bump.sh patch');
    const keys = Object.keys(ctx.pkg.devDependencies ?? {});
    expect(keys).toContain('@biomejs/biome');
    expect(keys).toEqual([...keys].sort());
  });

  test('ohne force bleibt Script-Drift erhalten', () => {
    const ctx = detectContext(project({ name: 'x', scripts: { lint: 'eslint .' } }));
    mutatePkg(ctx.pkg, computePkgPlan(ctx), false);
    expect(ctx.pkg.scripts?.lint).toBe('eslint .');
  });

  test('mit force wird Script-Drift auf den kanonischen Wert gesetzt', () => {
    const ctx = detectContext(project({ name: 'x', scripts: { lint: 'eslint .' } }));
    mutatePkg(ctx.pkg, computePkgPlan(ctx), true);
    expect(ctx.pkg.scripts?.lint).toBe('biome check .');
  });

  test('Versions-Drift (Projekt hinter Pin) wird ohne force angehoben — Scripts nicht', () => {
    const ctx = detectContext(
      project({
        name: 'x',
        devDependencies: { '@types/node': '^25.0.0' },
        scripts: { lint: 'eslint .' }
      })
    );
    mutatePkg(ctx.pkg, computePkgPlan(ctx), false); // KEIN force
    expect(ctx.pkg.devDependencies?.['@types/node']).toBe(VERSIONS['@types/node']); // angehoben
    expect(ctx.pkg.scripts?.lint).toBe('eslint .'); // Script-Drift bleibt (force-only)
  });
});

describe('pin/unpin & sicheres Anheben', () => {
  test('gepinnte devDep landet in devDepsPinned, nicht in Drift/Add', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } })
    );
    const plan = computePkgPlan(ctx, { pinned: new Set(['@types/node']) });
    expect(plan.devDepsDrift.some((d) => d.name === '@types/node')).toBe(false);
    expect(plan.devDepsToAdd.some((d) => d.name === '@types/node')).toBe(false);
    expect(plan.devDepsPinned.some((d) => d.name === '@types/node')).toBe(true);
  });

  test('gepinnte aber fehlende devDep wird gemeldet, nicht ergänzt (hands-off, nie still)', () => {
    const ctx = detectContext(project({ name: 'x' })); // @types/node nicht installiert
    const plan = computePkgPlan(ctx, { pinned: new Set(['@types/node']) });
    expect(plan.devDepsToAdd.some((d) => d.name === '@types/node')).toBe(false);
    expect(plan.devDepsPinned.some((d) => d.name === '@types/node' && d.from === undefined)).toBe(
      true
    );
  });

  test('mutatePkg lässt gepinnte devDep selbst mit force unberührt', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } })
    );
    mutatePkg(ctx.pkg, computePkgPlan(ctx, { pinned: new Set(['@types/node']) }), true);
    expect(ctx.pkg.devDependencies?.['@types/node']).toBe('^25.0.0');
  });

  test('Manifest persistiert pinned roundtrip', () => {
    const dir = project({ name: 'x' });
    writeManifest(dir, { ...emptyManifest(), pinned: { '@types/node': '^25.0.0' } }, false);
    expect(readManifest(dir).pinned).toEqual({ '@types/node': '^25.0.0' });
  });

  test('pin hält die aktuelle Range, unpin löst', () => {
    const dir = project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } });
    expect(runPin({ cwd: dir, dryRun: false, dep: '@types/node' })).toBe(0);
    expect(readManifest(dir).pinned['@types/node']).toBe('^25.0.0');
    expect(runUnpin({ cwd: dir, dryRun: false, dep: '@types/node' })).toBe(0);
    expect(readManifest(dir).pinned['@types/node']).toBeUndefined();
  });

  test('pin mit expliziter Range; ohne Range & ohne Installation → exit 2', () => {
    const dir = project({ name: 'x' });
    expect(runPin({ cwd: dir, dryRun: false, dep: 'foo', range: '^1.2.3' })).toBe(0);
    expect(readManifest(dir).pinned.foo).toBe('^1.2.3');
    expect(runPin({ cwd: dir, dryRun: false, dep: 'bar' })).toBe(2);
    expect(runPin({ cwd: dir, dryRun: false, dep: undefined })).toBe(2);
  });

  test('sync zieht hinter dem Pin liegende devDep ohne --force hoch', () => {
    const dir = project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } });
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@types/node']).toBe(VERSIONS['@types/node']);
  });

  test('gepinnte devDep bleibt bei sync unberührt', () => {
    const dir = project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } });
    runPin({ cwd: dir, dryRun: false, dep: '@types/node' });
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@types/node']).toBe('^25.0.0');
  });
});

describe('udx status', () => {
  const statusFlags = (cwd: string, svelte?: boolean) => ({ cwd, svelte, json: false });
  const rowsOf = (cwd: string, title: string, svelte?: boolean) =>
    buildReport(statusFlags(cwd, svelte)).sections.find((s) => s.title === title)?.rows ?? [];

  test('frisches Projekt: alle Dateien fehlen', () => {
    const rows = rowsOf(project({ name: 'x' }), 'Dateien');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.state === 'missing')).toBe(true);
  });

  test('behind devDep → state behind mit udx-sync-Befehl', () => {
    const dir = project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } });
    const row = rowsOf(dir, 'package.json', false).find((r) => r.label === '@types/node');
    expect(row?.state).toBe('behind');
    expect(row?.cmd).toBe('udx sync');
  });

  test('husky-Projekt → git-hooks declined-Zeile mit add-Befehl', () => {
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    const row = rowsOf(dir, 'Bausteine').find((r) => r.cmd?.includes('git-hooks'));
    expect(row?.state).toBe('declined');
    expect(row?.cmd).toBe('udx add git-hooks');
  });

  test('gepinnte devDep → state pinned mit unpin-Befehl', () => {
    const dir = project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } });
    runPin({ cwd: dir, dryRun: false, dep: '@types/node' });
    const row = rowsOf(dir, 'package.json', false).find((r) => r.label === '@types/node');
    expect(row?.state).toBe('pinned');
    expect(row?.cmd).toBe('udx unpin @types/node');
  });

  test('runStatus liefert 0 (Tabelle & json)', () => {
    const dir = project({ name: 'x' });
    expect(runStatus({ cwd: dir, svelte: false, json: false })).toBe(0);
    expect(runStatus({ cwd: dir, svelte: false, json: true })).toBe(0);
  });
});

describe('Verdrahtung (wiring)', () => {
  const statusOf = (dir: string, id: string) =>
    detectWiring(detectContext(dir)).find((s) => s.id === id)?.status;

  test('absent: ohne konsumierende Config', () => {
    const dir = project({ name: 'x' });
    expect(statusOf(dir, 'commitlint')).toBe('absent');
    expect(statusOf(dir, 'biome')).toBe('absent');
    expect(statusOf(dir, 'tsconfig')).toBe('absent');
  });

  test('wired: Config referenziert das @urbicon-Paket', () => {
    const dir = project({ name: 'x' });
    writeFileSync(
      join(dir, 'biome.json'),
      JSON.stringify({ extends: ['@urbicon/biome-config/biome-base.json'] })
    );
    writeFileSync(
      join(dir, 'commitlint.config.mjs'),
      "import { createConfig } from '@urbicon/commitlint-config';\n"
    );
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ extends: '@urbicon/tsconfig/base.json' })
    );
    expect(statusOf(dir, 'biome')).toBe('wired');
    expect(statusOf(dir, 'commitlint')).toBe('wired');
    expect(statusOf(dir, 'tsconfig')).toBe('wired');
  });

  test('self-managed: Config existiert, referenziert @urbicon aber nicht', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'biome.json'), JSON.stringify({ extends: ['./eigene.json'] }));
    writeFileSync(
      join(dir, 'commitlint.config.mjs'),
      "export default { extends: ['@commitlint/config-conventional'] };\n"
    );
    expect(statusOf(dir, 'biome')).toBe('self-managed');
    expect(statusOf(dir, 'commitlint')).toBe('self-managed');
  });

  test('commitlint findet auch andere Endungen (.js/.cjs/.ts)', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'commitlint.config.js'), "module.exports = { extends: ['x'] };\n");
    expect(statusOf(dir, 'commitlint')).toBe('self-managed');
  });

  test('tsconfig im Monorepo: wired, wenn ein Paket @urbicon/tsconfig extendet', () => {
    const dir = monorepo();
    writeFileSync(
      join(dir, 'packages/api/tsconfig.json'),
      JSON.stringify({ extends: '@urbicon/tsconfig/base.json' })
    );
    expect(statusOf(dir, 'tsconfig')).toBe('wired');
  });

  test('tsconfig im Monorepo: self-managed, wenn keine tsconfig @urbicon extendet', () => {
    const dir = monorepo();
    writeFileSync(join(dir, 'packages/api/tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
    expect(statusOf(dir, 'tsconfig')).toBe('self-managed');
  });

  test('wiringSkipDeps überspringt nur self-managed (nicht absent)', () => {
    const dir = project({ name: 'x' });
    writeFileSync(
      join(dir, 'commitlint.config.mjs'),
      "export default { extends: ['@commitlint/config-conventional'] };\n"
    );
    const skip = wiringSkipDeps(detectWiring(detectContext(dir)));
    expect(skip.has('@urbicon/commitlint-config')).toBe(true); // self-managed
    expect(skip.has('@urbicon/biome-config')).toBe(false); // absent ⇒ kein Skip
  });

  test('Gating: self-managed Config → @urbicon-Dep nicht „fehlt", sondern Verdrahtung-Zeile', () => {
    const dir = project({ name: 'x' });
    writeFileSync(
      join(dir, 'commitlint.config.mjs'),
      "export default { extends: ['@commitlint/config-conventional'] };\n"
    );
    const report = buildReport({ cwd: dir, svelte: false, json: false });
    const pkgRows = report.sections.find((s) => s.title === 'package.json')?.rows ?? [];
    expect(pkgRows.some((r) => r.label === '@urbicon/commitlint-config')).toBe(false);
    const wiringRows = report.sections.find((s) => s.title === 'Verdrahtung')?.rows ?? [];
    const row = wiringRows.find((r) => r.label === 'commitlint.config.mjs');
    expect(row?.state).toBe('unwired');
    expect(row?.cmd).toBe('udx sync --only commitlint --force');
  });
});

describe('applyFiles create-only Austausch (--only + --force)', () => {
  test('--only + --force ersetzt eine vorhandene create-only-Datei durch die Vorlage', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    writeFileSync(join(dir, 'commitlint.config.mjs'), '// eigene\n');
    const res = applyFiles(
      dir,
      ctx,
      { ...SYNC, force: true },
      emptyManifest(),
      new Map(),
      new Set(['commitlint'])
    );
    expect(readFileSync(join(dir, 'commitlint.config.mjs'), 'utf8')).toContain(
      '@urbicon/commitlint-config'
    );
    expect(res.find((r) => r.id === 'commitlint')?.action).toBe('updated');
  });

  test('--only ohne --force lässt die create-only-Datei unberührt', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'commitlint.config.mjs'), '// eigene\n');
    applyFiles(dir, detectContext(dir), SYNC, emptyManifest(), new Map(), new Set(['commitlint']));
    expect(readFileSync(join(dir, 'commitlint.config.mjs'), 'utf8')).toBe('// eigene\n');
  });

  test('blankes --force (ohne --only) lässt create-only unberührt (Sicherheitsgarantie)', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    writeFileSync(join(dir, 'commitlint.config.mjs'), '// eigene\n');
    applyFiles(dir, ctx, { ...SYNC, force: true }, emptyManifest());
    expect(readFileSync(join(dir, 'commitlint.config.mjs'), 'utf8')).toBe('// eigene\n');
  });
});

describe('ensureBunfig', () => {
  test('erstellt bunfig.toml mit @urbicon-Scope und Token', () => {
    const dir = project({ name: 'x' });
    expect(ensureBunfig(dir, false).action).toBe('created');
    const content = readFileSync(join(dir, 'bunfig.toml'), 'utf8');
    expect(content).toContain('[install.scopes]');
    expect(content).toContain(URBICON_REGISTRY);
    expect(content).toContain('$CODEBERG_TOKEN');
  });

  test('ist idempotent (vorhandene Registry-URL bleibt unverändert)', () => {
    const dir = project({ name: 'x' });
    ensureBunfig(dir, false);
    expect(ensureBunfig(dir, false).action).toBe('unchanged');
  });

  test('hängt den Block an bunfig.toml ohne install.scopes an', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'bunfig.toml'), '[test]\ncoverage = true\n');
    expect(ensureBunfig(dir, false).action).toBe('updated');
    const content = readFileSync(join(dir, 'bunfig.toml'), 'utf8');
    expect(content).toContain('[test]');
    expect(content).toContain(URBICON_REGISTRY);
  });

  test('überspringt bestehenden install.scopes-Block verlustfrei', () => {
    const dir = project({ name: 'x' });
    const orig = '[install.scopes]\n"@other" = { url = "https://example.com/" }\n';
    writeFileSync(join(dir, 'bunfig.toml'), orig);
    expect(ensureBunfig(dir, false).action).toBe('skipped');
    expect(readFileSync(join(dir, 'bunfig.toml'), 'utf8')).toBe(orig);
  });

  test('dry-run schreibt nichts', () => {
    const dir = project({ name: 'x' });
    expect(ensureBunfig(dir, true).action).toBe('would-create');
    expect(existsSync(join(dir, 'bunfig.toml'))).toBe(false);
  });
});

describe('Workspace-/Paket-Support', () => {
  test('resolveWorkspaces erkennt die Array-Form', () => {
    const dir = monorepo();
    const pkg = detectContext(dir).pkg;
    expect(resolveWorkspaces(dir, pkg)).toEqual(['packages/api', 'packages/ui']);
  });

  test('resolveWorkspaces erkennt die Objekt-Form (workspaces.packages)', () => {
    const dir = monorepo(true);
    const pkg = detectContext(dir).pkg;
    expect(resolveWorkspaces(dir, pkg)).toEqual(['packages/api', 'packages/ui']);
  });

  test('Single-Package ⇒ keine Workspaces', () => {
    const dir = project({ name: 'x' });
    expect(resolveWorkspaces(dir, detectContext(dir).pkg)).toEqual([]);
  });

  test('isTypeScriptPackage: TS-Paket (src/ oder dep) ja, reines Asset-Paket nein', () => {
    const tsDir = project({ name: 'ts', devDependencies: { typescript: '^6' } });
    expect(isTypeScriptPackage(tsDir, detectContext(tsDir).pkg)).toBe(true);
    const assetDir = project({ name: 'asset' }); // nur package.json, kein src/, kein TS-dep
    expect(isTypeScriptPackage(assetDir, detectContext(assetDir).pkg)).toBe(false);
  });

  test('init überspringt reine Asset-Pakete (keine tsconfig)', () => {
    const dir = monorepo();
    // ein reines Asset-Paket ohne src/ und ohne TS-Signal:
    mkdirSync(join(dir, 'packages/assets'), { recursive: true });
    writeFileSync(join(dir, 'packages/assets/package.json'), JSON.stringify({ name: 'assets' }));
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(existsSync(join(dir, 'packages/assets/tsconfig.json'))).toBe(false);
    expect(existsSync(join(dir, 'packages/api/tsconfig.json'))).toBe(true); // TS-Paket
  });

  test('package-scoped Templates sind create-only (sonst Hash-Kollision im Monorepo)', () => {
    for (const t of FILE_TEMPLATES) {
      if ((t.scope ?? 'root') === 'package') expect(t.policy).toBe('create-only');
    }
  });

  test('scope-Filter trennt Root- von Paket-Bausteinen', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    applyFiles(dir, ctx, { ...INIT, scope: 'root' }, emptyManifest());
    expect(existsSync(join(dir, 'cliff.toml'))).toBe(true);
    expect(existsSync(join(dir, 'tsconfig.json'))).toBe(false); // package-scoped, nicht im Root

    const dir2 = project({ name: 'y' });
    applyFiles(dir2, detectContext(dir2), { ...INIT, scope: 'package' }, emptyManifest());
    expect(existsSync(join(dir2, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(dir2, 'cliff.toml'))).toBe(false); // root-scoped, nicht hier
  });

  test('init in Monorepo: tsconfig je Paket (Svelte je Paket), nicht im Root', () => {
    const dir = monorepo();
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(existsSync(join(dir, 'packages/api/tsconfig.json'))).toBe(true);
    expect(existsSync(join(dir, 'packages/ui/tsconfig.json'))).toBe(true);
    expect(existsSync(join(dir, 'tsconfig.json'))).toBe(false); // Root unberührt
    expect(existsSync(join(dir, 'cliff.toml'))).toBe(true); // Root-Baustein da
    // Svelte je Paket erkannt:
    expect(readFileSync(join(dir, 'packages/ui/tsconfig.json'), 'utf8')).toContain('svelte');
    expect(readFileSync(join(dir, 'packages/api/tsconfig.json'), 'utf8')).toContain('base.json');
  });
});

describe('formatDiff', () => {
  test('identische Texte ergeben leeren Diff', () => {
    expect(formatDiff('a\nb\n', 'a\nb\n')).toBe('');
  });

  test('leere Ausgangs-/Zieldatei: reines Add bzw. Delete inkl. Header-Mathematik', () => {
    const add = formatDiff('', 'a\nb\n', { color: false });
    expect(add).toContain('+ a');
    expect(add).toContain('@@ -1,0 +1,2 @@');
    const del = formatDiff('a\nb\n', '', { color: false });
    expect(del).toContain('- a');
    expect(del).toContain('@@ -1,2 +1,0 @@');
    expect(formatDiff('', '')).toBe(''); // beide leer = kein Diff
  });

  test('zeigt geänderte Zeile mit Kontext und Hunk-Header', () => {
    const d = formatDiff('a\nb\nc\n', 'a\nB\nc\n', { color: false });
    expect(d).toContain('- b');
    expect(d).toContain('+ B');
    expect(d).toContain('  a'); // Kontextzeile
    expect(d.split('\n').some((l) => l.startsWith('@@'))).toBe(true);
  });

  test('reines Hinzufügen / reines Löschen', () => {
    expect(formatDiff('a\n', 'a\nb\n', { color: false })).toContain('+ b');
    expect(formatDiff('a\nb\n', 'a\n', { color: false })).toContain('- b');
  });

  test('color:false enthält keine ANSI-Codes', () => {
    expect(formatDiff('a\n', 'b\n', { color: false })).not.toContain('[');
  });

  test('begrenzt Kontext: zwei weit getrennte Änderungen ⇒ zwei Hunks, Mitte unsichtbar', () => {
    const old = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const neu = old.replace('line 0', 'X0').replace('line 39', 'X39');
    const d = formatDiff(old, neu, { color: false, context: 2 });
    expect(d).toContain('X0');
    expect(d).toContain('X39');
    expect(d).not.toContain('line 20');
    expect(d.split('\n').filter((l) => l.startsWith('@@')).length).toBe(2);
  });
});

describe('applyFiles --diff', () => {
  test('liefert Diff bei Konflikt, wenn diff gesetzt', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'cliff.toml'), 'FREMD\n');
    const res = applyFiles(dir, detectContext(dir), { ...SYNC, diff: true }, emptyManifest());
    const r = res.find((x) => x.dest === 'cliff.toml');
    expect(r?.action).toBe('conflict');
    expect(r?.diff).toContain('FREMD');
  });

  test('ohne diff-Flag kein Diff im Ergebnis', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'cliff.toml'), 'FREMD\n');
    const res = applyFiles(dir, detectContext(dir), SYNC, emptyManifest());
    expect(res.find((x) => x.dest === 'cliff.toml')?.diff).toBeUndefined();
  });
});

describe('Versionierung', () => {
  test('@urbicon-Pins entsprechen der eigenen Paketversion (unified)', () => {
    const own = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')
    ).version;
    expect(VERSIONS['@urbicon/biome-config']).toBe(`^${own}`);
    expect(VERSIONS['@urbicon/commitlint-config']).toBe(`^${own}`);
    expect(VERSIONS['@urbicon/tsconfig']).toBe(`^${own}`);
  });

  test('VERSIONS spiegeln den Root-Catalog (single source: Tool + Svelte)', () => {
    // Der Catalog ist die EINE Quelle; VERSIONS leitet sich daraus ab. Bricht dieser Test, ist
    // versions.ts vom Catalog entkoppelt (statt ihn nur zu lesen) — ein Bump würde nicht propagieren.
    const ws = JSON.parse(
      readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf8')
    ).workspaces;
    for (const n of TOOL_DEPS) expect(VERSIONS[n]).toBe(ws.catalog[n]);
    for (const n of SVELTE_DEPS) expect(VERSIONS[n]).toBe(ws.catalogs.svelte[n]);
  });

  test('jeder vorgeschriebene Dep-Name hat einen Catalog-Eintrag (Completeness)', () => {
    const ws = JSON.parse(
      readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf8')
    ).workspaces;
    for (const n of TOOL_DEPS) expect(ws.catalog[n]).toBeDefined();
    for (const n of SVELTE_DEPS) expect(ws.catalogs.svelte[n]).toBeDefined();
  });

  test('udx-Pakete referenzieren catalog-Deps via catalog: (dogfooding, alle Pakete & Dep-Typen)', () => {
    // udx nutzt seinen eigenen Catalog konsequent: kein literaler Pin für eine Dep, die im Catalog
    // steht — sonst zöge `bun outdated`/ein Stack-Update sie nicht mehr mit (stiller Pin-Lag).
    const rootDir = join(import.meta.dir, '..', '..', '..');
    const rootPkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
    const ws = rootPkg.workspaces;
    const catalogNames = new Set([...Object.keys(ws.catalog), ...Object.keys(ws.catalogs.svelte)]);
    const offenders: string[] = [];
    for (const d of ['.', ...resolveWorkspaces(rootDir, rootPkg)]) {
      const pkg = JSON.parse(readFileSync(join(rootDir, d, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [name, range] of Object.entries(deps)) {
        if (catalogNames.has(name) && !String(range).startsWith('catalog:')) {
          offenders.push(`${d}/${name}=${range}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('alle Workspace-Pakete tragen dieselbe Version', () => {
    const root = join(import.meta.dir, '..', '..');
    const versions = ['cli', 'biome-config', 'commitlint-config', 'tsconfig'].map(
      (p) => JSON.parse(readFileSync(join(root, p, 'package.json'), 'utf8')).version
    );
    expect(new Set(versions).size).toBe(1);
  });
});

describe('Hilfe (--help)', () => {
  // Versionsneutral (fester Platzhalter) + ANSI-frei ⇒ stabil über Bumps und TTY-Modi.
  const help = stripAnsi(helpText('1.2.3'));

  test('Snapshot der vollständigen Hilfe', () => {
    expect(help).toMatchSnapshot();
  });

  test('führt die Dev-facing Verben als Befehle', () => {
    for (const cmd of ['init', 'status', 'sync', 'add <id>', 'remove <id>', 'pin', 'unpin']) {
      expect(help).toContain(cmd);
    }
  });

  test('adopt/skip/doctor erscheinen nur als Aliase, nicht in der Befehlstabelle', () => {
    const befehle = help.slice(help.indexOf('Befehle'), help.indexOf('Optionen'));
    for (const legacy of ['adopt', 'skip', 'doctor']) expect(befehle).not.toContain(legacy);
    // …aber in der Aliase-Fußnote schon:
    expect(help).toContain('Aliase');
    for (const legacy of ['adopt', 'skip', 'doctor']) expect(help).toContain(legacy);
  });
});
