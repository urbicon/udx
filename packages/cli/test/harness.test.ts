import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFiles, ensureBunfig, URBICON_REGISTRY } from '../src/lib/apply.ts';
import { detectContext } from '../src/lib/detect.ts';
import { computePkgPlan, mutatePkg } from '../src/lib/pkg.ts';
import { VERSIONS } from '../src/lib/versions.ts';

function project(pkg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'udx-test-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

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
    const ctx = detectContext(dir);
    applyFiles(dir, ctx, { mode: 'init', dryRun: false, force: false });
    expect(existsSync(join(dir, 'cliff.toml'))).toBe(true);
    expect(existsSync(join(dir, 'biome.json'))).toBe(true);
    expect(existsSync(join(dir, 'scripts/bump.sh'))).toBe(true);
  });

  test('dry-run schreibt nichts', () => {
    const dir = project({ name: 'x' });
    applyFiles(dir, detectContext(dir), { mode: 'init', dryRun: true, force: false });
    expect(existsSync(join(dir, 'cliff.toml'))).toBe(false);
  });

  test('create-only bleibt, managed wird via sync aktualisiert', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    applyFiles(dir, ctx, { mode: 'init', dryRun: false, force: false });

    writeFileSync(join(dir, 'biome.json'), '{"custom":true}');
    writeFileSync(join(dir, 'cliff.toml'), '# eigenes');
    const res = applyFiles(dir, ctx, { mode: 'sync', dryRun: false, force: false });

    expect(readFileSync(join(dir, 'biome.json'), 'utf8')).toBe('{"custom":true}');
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).not.toBe('# eigenes');
    expect(res.find((r) => r.dest === 'biome.json')?.action).toBe('skipped');
    expect(res.find((r) => r.dest === 'cliff.toml')?.action).toBe('updated');
  });

  test('svelte: biome ignoriert .svelte, .prettierrc existiert', () => {
    const dir = project({ name: 'x', devDependencies: { svelte: '^5' } });
    applyFiles(dir, detectContext(dir), { mode: 'init', dryRun: false, force: false });
    expect(readFileSync(join(dir, 'biome.json'), 'utf8')).toContain('!**/*.svelte');
    expect(existsSync(join(dir, '.prettierrc'))).toBe(true);
  });

  test('reines TS-Projekt bekommt keine prettier-Dateien', () => {
    const dir = project({ name: 'x' });
    applyFiles(dir, detectContext(dir), { mode: 'init', dryRun: false, force: false });
    expect(existsSync(join(dir, '.prettierrc'))).toBe(false);
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

describe('applyFiles force-Modus', () => {
  test('init --force überschreibt abweichende managed-Dateien', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    applyFiles(dir, ctx, { mode: 'init', dryRun: false, force: false });
    writeFileSync(join(dir, 'cliff.toml'), '# eigenes');
    const res = applyFiles(dir, ctx, { mode: 'init', dryRun: false, force: true });
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).not.toBe('# eigenes');
    expect(res.find((r) => r.dest === 'cliff.toml')?.action).toBe('updated');
  });

  test('init ohne force lässt abweichende managed-Datei stehen (skipped)', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    applyFiles(dir, ctx, { mode: 'init', dryRun: false, force: false });
    writeFileSync(join(dir, 'cliff.toml'), '# eigenes');
    const res = applyFiles(dir, ctx, { mode: 'init', dryRun: false, force: false });
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).toBe('# eigenes');
    expect(res.find((r) => r.dest === 'cliff.toml')?.action).toBe('skipped');
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
