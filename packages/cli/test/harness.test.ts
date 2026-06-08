import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdopt, runSkip } from '../src/commands/capability.ts';
import { runHarness } from '../src/commands/harness.ts';
import { type ApplyOptions, applyFiles, ensureBunfig, URBICON_REGISTRY } from '../src/lib/apply.ts';
import {
  CAPABILITIES,
  declinedSets,
  resolveCapabilities,
  resolveSelection
} from '../src/lib/capabilities.ts';
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
  satisfiesPin
} from '../src/lib/pkg.ts';
import { SVELTE_DEPS, TOOL_DEPS, VERSIONS } from '../src/lib/versions.ts';
import { isTypeScriptPackage, resolveWorkspaces } from '../src/lib/workspace.ts';
import { FILE_TEMPLATES } from '../src/templates/index.ts';

function project(pkg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'udx-test-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

/** Legt ein Monorepo an: Root + packages/api (TS, mit src/) + packages/ui (Svelte). `objectForm` nutzt `workspaces.packages`. */
function monorepo(objectForm = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'udx-mono-'));
  const workspaces = objectForm ? { packages: ['packages/*'] } : ['packages/*'];
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
  interactive: false
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

  test('alle Workspace-Pakete tragen dieselbe Version', () => {
    const root = join(import.meta.dir, '..', '..');
    const versions = ['cli', 'biome-config', 'commitlint-config', 'tsconfig'].map(
      (p) => JSON.parse(readFileSync(join(root, p, 'package.json'), 'utf8')).version
    );
    expect(new Set(versions).size).toBe(1);
  });
});
