import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ApplyOptions, applyFiles, ensureBunfig, URBICON_REGISTRY } from '../src/lib/apply.ts';
import { detectContext, type ProjectContext } from '../src/lib/detect.ts';
import {
  emptyManifest,
  hashContent,
  MANIFEST_FILE,
  type Manifest,
  readManifest,
  writeManifest
} from '../src/lib/manifest.ts';
import { computePkgPlan, mutatePkg } from '../src/lib/pkg.ts';
import { VERSIONS } from '../src/lib/versions.ts';

function project(pkg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'udx-test-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

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
    const m: Manifest = { harness: '1.0.0', declined: {}, files: { 'cliff.toml': 'abc' } };
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

describe('Versionierung', () => {
  test('@urbicon-Pins entsprechen der eigenen Paketversion (unified)', () => {
    const own = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')
    ).version;
    expect(VERSIONS['@urbicon/biome-config']).toBe(`^${own}`);
    expect(VERSIONS['@urbicon/commitlint-config']).toBe(`^${own}`);
    expect(VERSIONS['@urbicon/tsconfig']).toBe(`^${own}`);
  });

  test('alle Workspace-Pakete tragen dieselbe Version', () => {
    const root = join(import.meta.dir, '..', '..');
    const versions = ['cli', 'biome-config', 'commitlint-config', 'tsconfig'].map(
      (p) => JSON.parse(readFileSync(join(root, p, 'package.json'), 'utf8')).version
    );
    expect(new Set(versions).size).toBe(1);
  });
});
