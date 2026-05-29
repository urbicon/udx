import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFiles } from '../src/lib/apply.ts';
import { detectContext } from '../src/lib/detect.ts';
import { computePkgPlan } from '../src/lib/pkg.ts';

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
