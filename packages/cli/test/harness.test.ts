import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdd, runAdopt, runSkip } from '../src/commands/capability.ts';
import { biomeSchemaVersion, prettierUsesTabs, runDoctor } from '../src/commands/doctor.ts';
import { installPlan, runHarness } from '../src/commands/harness.ts';
import { helpText } from '../src/commands/help.ts';
import { runPin, runUnpin } from '../src/commands/pin.ts';
import { buildReport, runStatus } from '../src/commands/status.ts';
import {
  type ApplyOptions,
  applyFiles,
  LEGACY_REGISTRY,
  pruneLegacyRegistry
} from '../src/lib/apply.ts';
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
import {
  RENAMED_FROM,
  SVELTE_DEPS,
  TOOL_DEPS,
  URBICON_DEPS,
  VERSIONS
} from '../src/lib/versions.ts';
import { detectWiring, wiringSkipDeps } from '../src/lib/wiring.ts';
import { isTypeScriptPackage, resolveWorkspaces } from '../src/lib/workspace.ts';
import { FILE_TEMPLATES } from '../src/templates/index.ts';

function project(pkg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'udx-test-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

/**
 * Sets up a monorepo: root + packages/api (TS, with src/) + packages/ui (Svelte). `objectForm` uses
 * `workspaces.packages`; `catalog` (implies object form) attaches a Bun catalog = catalog mode.
 */
function monorepo(objectForm = false, catalog?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'udx-mono-'));
  const workspaces =
    objectForm || catalog
      ? { packages: ['packages/*'], ...(catalog ? { catalog } : {}) }
      : ['packages/*'];
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces }));
  mkdirSync(join(dir, 'packages/api/src'), { recursive: true }); // src/ ⇒ TS package
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

/** applyFiles with a fresh manifest (for tests that don't provide the manifest state themselves). */
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

/** Strip ANSI escapes so the help snapshot is stable regardless of TTY/NO_COLOR. */
const stripAnsi = (s: string): string =>
  s.replace(new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'g'), '');

describe('detectContext', () => {
  test('detects Svelte via devDependencies', () => {
    expect(detectContext(project({ name: 'x', devDependencies: { svelte: '^5' } })).svelte).toBe(
      true
    );
  });
  test('plain TS project is not svelte', () => {
    expect(detectContext(project({ name: 'x' })).svelte).toBe(false);
  });
  test('override forces svelte', () => {
    expect(detectContext(project({ name: 'x' }), true).svelte).toBe(true);
  });
});

describe('applyFiles', () => {
  test('init creates managed + create-only files', () => {
    const dir = project({ name: 'x' });
    apply(dir, detectContext(dir), INIT);
    expect(existsSync(join(dir, 'cliff.toml'))).toBe(true);
    expect(existsSync(join(dir, 'biome.json'))).toBe(true);
    expect(existsSync(join(dir, 'scripts/bump.sh'))).toBe(true);
  });

  test('dry-run writes nothing', () => {
    const dir = project({ name: 'x' });
    apply(dir, detectContext(dir), { mode: 'init', dryRun: true, force: false });
    expect(existsSync(join(dir, 'cliff.toml'))).toBe(false);
  });

  test('create-only is preserved on sync', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    const m = emptyManifest();
    applyFiles(dir, ctx, INIT, m);
    writeFileSync(join(dir, 'biome.json'), '{"custom":true}');
    const res = applyFiles(dir, ctx, SYNC, m);
    expect(readFileSync(join(dir, 'biome.json'), 'utf8')).toBe('{"custom":true}');
    expect(res.find((r) => r.dest === 'biome.json')?.action).toBe('skipped');
  });

  test('svelte: biome ignores .svelte, .prettierrc exists', () => {
    const dir = project({ name: 'x', devDependencies: { svelte: '^5' } });
    apply(dir, detectContext(dir), INIT);
    expect(readFileSync(join(dir, 'biome.json'), 'utf8')).toContain('!**/*.svelte');
    expect(existsSync(join(dir, '.prettierrc'))).toBe(true);
  });

  test('plain TS project gets no prettier files', () => {
    const dir = project({ name: 'x' });
    apply(dir, detectContext(dir), INIT);
    expect(existsSync(join(dir, '.prettierrc'))).toBe(false);
  });

  test('biome.json always excludes .svelte — even without Svelte (monorepo root safeguard)', () => {
    const dir = project({ name: 'x' }); // plain TS, no svelte
    apply(dir, detectContext(dir), INIT);
    expect(readFileSync(join(dir, 'biome.json'), 'utf8')).toContain('!**/*.svelte');
  });
});

describe('3-way drift (managed)', () => {
  test('init remembers hashes of managed files, not create-only', () => {
    const dir = project({ name: 'x' });
    const m = emptyManifest();
    applyFiles(dir, detectContext(dir), INIT, m);
    expect(m.files['cliff.toml']).toBeDefined();
    expect(m.files['scripts/bump.sh']).toBeDefined();
    expect(m.files['biome.json']).toBeUndefined();
  });

  test('untouched-stale managed file is updated via sync', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    // Simulates: udx previously wrote "ALT\n" and remembered its hash.
    writeFileSync(join(dir, 'cliff.toml'), 'ALT\n');
    const m: Manifest = { ...emptyManifest(), files: { 'cliff.toml': hashContent('ALT\n') } };
    const res = applyFiles(dir, ctx, SYNC, m);
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).not.toBe('ALT\n');
    expect(res.find((r) => r.dest === 'cliff.toml')?.action).toBe('updated');
    expect(m.files['cliff.toml']).toBe(hashContent(readFileSync(join(dir, 'cliff.toml'), 'utf8')));
  });

  test('locally modified managed file is protected by sync, --force applies it', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    writeFileSync(join(dir, 'cliff.toml'), 'EDITED\n');
    // remembered hash points at a different ("ALT") state ⇒ locally modified.
    const m: Manifest = { ...emptyManifest(), files: { 'cliff.toml': hashContent('ALT\n') } };

    const res = applyFiles(dir, ctx, SYNC, m);
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).toBe('EDITED\n');
    expect(res.find((r) => r.dest === 'cliff.toml')?.action).toBe('conflict');

    const forced = applyFiles(dir, ctx, { ...SYNC, force: true }, m);
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).not.toBe('EDITED\n');
    expect(forced.find((r) => r.dest === 'cliff.toml')?.action).toBe('updated');
    // hash advances to the written state ⇒ the next sync sees no conflict.
    expect(m.files['cliff.toml']).toBe(hashContent(readFileSync(join(dir, 'cliff.toml'), 'utf8')));
  });

  test('foreign file without a remembered hash counts as a conflict (first migration)', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'cliff.toml'), 'FREMD\n');
    const res = applyFiles(dir, detectContext(dir), SYNC, emptyManifest());
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).toBe('FREMD\n');
    expect(res.find((r) => r.dest === 'cliff.toml')?.action).toBe('conflict');
  });

  test('identical file without a manifest entry is recorded (unchanged)', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    applyFiles(dir, ctx, INIT, emptyManifest()); // creates cliff.toml at the template state
    const m = emptyManifest(); // fresh manifest without a hash
    const res = applyFiles(dir, ctx, SYNC, m);
    expect(res.find((r) => r.dest === 'cliff.toml')?.action).toBe('unchanged');
    expect(m.files['cliff.toml']).toBeDefined();
  });

  test('dry-run does not mutate the manifest', () => {
    const dir = project({ name: 'x' });
    const m = emptyManifest();
    applyFiles(dir, detectContext(dir), { mode: 'init', dryRun: true, force: false }, m);
    expect(Object.keys(m.files)).toHaveLength(0);
  });
});

describe('applyFiles force mode', () => {
  test('init --force overwrites a locally modified managed file', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    const m = emptyManifest();
    applyFiles(dir, ctx, INIT, m);
    writeFileSync(join(dir, 'cliff.toml'), '# eigenes');
    const res = applyFiles(dir, ctx, { mode: 'init', dryRun: false, force: true }, m);
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).not.toBe('# eigenes');
    expect(res.find((r) => r.dest === 'cliff.toml')?.action).toBe('updated');
  });

  test('init without force reports a locally modified managed file as a conflict', () => {
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
  test('readManifest returns an empty manifest when no file exists', () => {
    const dir = project({ name: 'x' });
    expect(readManifest(dir)).toEqual(emptyManifest());
  });

  test('writeManifest writes .udx.json and is idempotent', () => {
    const dir = project({ name: 'x' });
    const m: Manifest = { ...emptyManifest(), harness: '1.0.0', files: { 'cliff.toml': 'abc' } };
    expect(writeManifest(dir, m, false)).toBe(true);
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(true);
    expect(writeManifest(dir, m, false)).toBe(false); // unchanged ⇒ no write
    expect(readManifest(dir)).toEqual(m);
  });

  test('writeManifest dry-run writes nothing', () => {
    const dir = project({ name: 'x' });
    expect(writeManifest(dir, { ...emptyManifest(), harness: '1.0.0' }, true)).toBe(true);
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });

  test('a corrupted manifest is treated as empty', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, MANIFEST_FILE), '{ kaputt');
    expect(readManifest(dir)).toEqual(emptyManifest());
  });

  test('corrupt (non-string) entries are discarded entry by entry', () => {
    const dir = project({ name: 'x' });
    writeFileSync(
      join(dir, MANIFEST_FILE),
      JSON.stringify({ harness: 1, declined: [], files: { ok: 'abc', bad: null, n: 42 } })
    );
    const m = readManifest(dir);
    expect(m.harness).toBe(''); // non-string ⇒ default
    expect(m.declined).toEqual({}); // array ⇒ discarded
    expect(m.files).toEqual({ ok: 'abc' }); // only the string entry remains
  });
});

describe('capabilities', () => {
  test('table references only existing templates/scripts/deps', () => {
    // Svelte context, so that svelte-specific scripts/deps are covered too.
    const ctx = detectContext(project({ name: 'x', devDependencies: { svelte: '^5' } }));
    const fileIds = new Set(FILE_TEMPLATES.map((t) => t.id));
    const scriptNames = new Set(Object.keys(canonicalScripts(ctx)));
    const depNames = new Set(Object.keys(canonicalDevDeps(ctx)));
    for (const cap of CAPABILITIES) {
      for (const f of cap.files) expect(fileIds).toContain(f);
      for (const s of cap.scripts) expect(scriptNames).toContain(s);
      for (const d of cap.devDeps) {
        expect(VERSIONS[d]).toBeDefined();
        expect(depNames).toContain(d); // must actually be planned too
      }
    }
  });

  test('declining lint-format skips svelte-specific lint/format deps', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { svelte: '^5', eslint: '^9' } })
    );
    const sets = declinedSets(resolveCapabilities(ctx, emptyManifest()));
    const plan = computePkgPlan(ctx, { skip: { scripts: sets.scripts, devDeps: sets.devDeps } });
    expect(plan.devDepsToAdd.some((d) => d.name === 'svelte-check')).toBe(false);
    expect(plan.devDepsToAdd.some((d) => d.name === '@biomejs/biome')).toBe(false);
    // `prettier` stays (shared by the git-hooks prettier hook):
    expect(plan.devDepsToAdd.some((d) => d.name === 'prettier')).toBe(true);
  });

  test('a stale auto-decline reason is marked as stale', () => {
    // husky once detected and persisted, but now gone ⇒ stale.
    const m: Manifest = { ...emptyManifest(), declined: { 'git-hooks': 'husky' } };
    const st = resolveCapabilities(detectContext(project({ name: 'x' })), m).find(
      (s) => s.cap.id === 'git-hooks'
    );
    expect(st?.stale).toBe(true);
  });

  test('a manual decline is never stale', () => {
    const m: Manifest = { ...emptyManifest(), declined: { 'git-hooks': 'manual' } };
    const st = resolveCapabilities(detectContext(project({ name: 'x' })), m).find(
      (s) => s.cap.id === 'git-hooks'
    );
    expect(st?.stale).toBe(false);
  });

  test('husky project auto-declines git-hooks (fresh)', () => {
    const ctx = detectContext(project({ name: 'x', devDependencies: { husky: '^9' } }));
    const st = resolveCapabilities(ctx, emptyManifest()).find((s) => s.cap.id === 'git-hooks');
    expect(st?.declined).toBe(true);
    expect(st?.reason).toBe('husky');
    expect(st?.fresh).toBe(true);
  });

  test('.husky directory triggers a decline (without a devDep)', () => {
    const dir = project({ name: 'x' });
    mkdirSync(join(dir, '.husky'));
    const st = resolveCapabilities(detectContext(dir), emptyManifest()).find(
      (s) => s.cap.id === 'git-hooks'
    );
    expect(st?.reason).toBe('husky');
  });

  test('eslint project declines lint-format', () => {
    const ctx = detectContext(project({ name: 'x', devDependencies: { eslint: '^9' } }));
    const st = resolveCapabilities(ctx, emptyManifest()).find((s) => s.cap.id === 'lint-format');
    expect(st?.declined).toBe(true);
    expect(st?.reason).toBe('eslint');
  });

  test('a persisted decline is not fresh', () => {
    const ctx = detectContext(project({ name: 'x' }));
    const m: Manifest = { ...emptyManifest(), declined: { 'git-hooks': 'manual' } };
    const st = resolveCapabilities(ctx, m).find((s) => s.cap.id === 'git-hooks');
    expect(st).toMatchObject({ declined: true, reason: 'manual', fresh: false });
  });

  test('a clean project declines nothing', () => {
    const states = resolveCapabilities(detectContext(project({ name: 'x' })), emptyManifest());
    expect(states.every((s) => !s.declined)).toBe(true);
  });

  test('declinedSets folds together files/scripts/devDeps', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { husky: '^9', eslint: '^9' } })
    );
    const sets = declinedSets(resolveCapabilities(ctx, emptyManifest()));
    expect(sets.files.get('lefthook')).toBe('declined (husky)');
    expect(sets.files.get('biome')).toBe('declined (eslint)');
    expect(sets.scripts.has('prepare')).toBe(true);
    expect(sets.devDeps.has('@biomejs/biome')).toBe(true);
  });

  test('a declined capability file is skipped in applyFiles', () => {
    const dir = project({ name: 'x' });
    const res = applyFiles(
      dir,
      detectContext(dir),
      INIT,
      emptyManifest(),
      new Map([['lefthook', 'declined (husky)']])
    );
    expect(existsSync(join(dir, 'lefthook.yml'))).toBe(false);
    const r = res.find((x) => x.dest === 'lefthook.yml');
    expect(r?.action).toBe('skipped');
    expect(r?.note).toContain('husky');
  });

  test('computePkgPlan skips declined scripts/devDeps (skip)', () => {
    const ctx = detectContext(project({ name: 'x' }));
    const plan = computePkgPlan(ctx, {
      skip: { scripts: new Set(['prepare']), devDeps: new Set(['lefthook']) }
    });
    expect(plan.scriptsToAdd.some((s) => s.name === 'prepare')).toBe(false);
    expect(plan.devDepsToAdd.some((d) => d.name === 'lefthook')).toBe(false);
  });

  test('computePkgPlan only-whitelist restricts the plan', () => {
    const ctx = detectContext(project({ name: 'x' }));
    const plan = computePkgPlan(ctx, {
      only: { scripts: new Set(['lint']), devDeps: new Set(['@biomejs/biome']) }
    });
    expect(plan.scriptsToAdd.map((s) => s.name)).toEqual(['lint']);
    expect(plan.devDepsToAdd.map((d) => d.name)).toEqual(['@biomejs/biome']);
  });
});

describe('git-hooks: core.hooksPath detection', () => {
  test('prepare script with core.hooksPath declines git-hooks', () => {
    const ctx = detectContext(
      project({ name: 'x', scripts: { prepare: 'git config core.hooksPath .githooks' } })
    );
    const st = resolveCapabilities(ctx, emptyManifest()).find((s) => s.cap.id === 'git-hooks');
    expect(st?.declined).toBe(true);
    expect(st?.reason).toBe('core.hooksPath');
  });

  test('.githooks directory declines git-hooks (even without a setup script)', () => {
    const dir = project({ name: 'x' });
    mkdirSync(join(dir, '.githooks'));
    const st = resolveCapabilities(detectContext(dir), emptyManifest()).find(
      (s) => s.cap.id === 'git-hooks'
    );
    expect(st?.reason).toBe('core.hooksPath');
  });

  test('postinstall script with core.hooksPath declines as well', () => {
    const ctx = detectContext(
      project({ name: 'x', scripts: { postinstall: 'git config core.hooksPath .hooks' } })
    );
    const st = resolveCapabilities(ctx, emptyManifest()).find((s) => s.cap.id === 'git-hooks');
    expect(st?.reason).toBe('core.hooksPath');
  });
});

describe('prettierignore template', () => {
  test('uses a gitignore-compatible re-include (no ineffective **/* + !**/*.svelte)', () => {
    // Regression: a re-include does not take effect below excluded directories —
    // with `**/*` Prettier saw zero files. `!*/` must keep the directories open.
    const tpl = FILE_TEMPLATES.find((t) => t.id === 'prettierignore');
    const out = tpl?.render({ svelte: true, projectName: 'x' }) ?? '';
    expect(out).toContain('!*/');
    expect(out).toContain('!*.svelte');
    expect(out).not.toContain('**/*');
  });

  // .prettierignore encodes the fixed Biome/Prettier boundary (mechanic) ⇒ managed, while
  // .prettierrc (preferences) stays create-only. So sync can catch up a stale/scaffold ignore.
  test('is managed: its hash is remembered, .prettierrc (create-only) is not', () => {
    expect(FILE_TEMPLATES.find((t) => t.id === 'prettierignore')?.policy).toBe('managed');
    expect(FILE_TEMPLATES.find((t) => t.id === 'prettierrc')?.policy).toBe('create-only');
    const dir = project({ name: 'x', devDependencies: { svelte: '^5' } });
    const m = emptyManifest();
    applyFiles(dir, detectContext(dir), INIT, m);
    expect(m.files['.prettierignore']).toBeDefined(); // managed → hashed
    expect(m.files['.prettierrc']).toBeUndefined(); // create-only → not hashed
  });

  test('a stale udx-written .prettierignore (lockfiles only) is caught up by sync', () => {
    const dir = project({ name: 'x', devDependencies: { svelte: '^5' } });
    // pre-udx scaffold ignore: only lockfiles → lets Prettier reformat package.json (the cookery bug).
    const old = 'package-lock.json\npnpm-lock.yaml\nyarn.lock\n';
    writeFileSync(join(dir, '.prettierignore'), old);
    // udx had written exactly this before ⇒ hash known ⇒ untouched-stale, safe to update.
    const m: Manifest = { ...emptyManifest(), files: { '.prettierignore': hashContent(old) } };
    const res = applyFiles(dir, detectContext(dir), SYNC, m);
    expect(res.find((r) => r.dest === '.prettierignore')?.action).toBe('updated');
    expect(readFileSync(join(dir, '.prettierignore'), 'utf8')).toContain('!*.svelte');
  });

  test('an unknown .prettierignore (no manifest hash) is protected as conflict — --force needed', () => {
    const dir = project({ name: 'x', devDependencies: { svelte: '^5' } });
    writeFileSync(join(dir, '.prettierignore'), 'package-lock.json\n');
    const res = applyFiles(dir, detectContext(dir), SYNC, emptyManifest());
    expect(res.find((r) => r.dest === '.prettierignore')?.action).toBe('conflict');
  });
});

describe('dep-updates (renovate)', () => {
  const stateOf = (dir: string, id = 'dep-updates') =>
    resolveCapabilities(detectContext(dir), emptyManifest()).find((s) => s.cap.id === id);

  test('init produces renovate.json identical to the dogfooded root config', () => {
    const dir = project({ name: 'x' });
    apply(dir, detectContext(dir), INIT);
    const rendered = readFileSync(join(dir, 'renovate.json'), 'utf8');
    const root = readFileSync(join(import.meta.dir, '../../../renovate.json'), 'utf8');
    expect(rendered).toBe(root);
  });

  test('tracks the biome.json $schema version as @biomejs/biome (against schema drift)', () => {
    const cfg = JSON.parse(readFileSync(join(import.meta.dir, '../../../renovate.json'), 'utf8'));
    const cm = cfg.customManagers.find((m: { fileMatch?: string[] }) =>
      m.fileMatch?.includes('^biome\\.json$')
    );
    expect(cm?.depNameTemplate).toBe('@biomejs/biome');
    expect(cm?.matchStrings?.[0]).toContain('biomejs');
    // … and bundled in the stack group, so the catalog pin + $schema bump in the same PR:
    const stack = cfg.packageRules.find(
      (r: { groupName?: string }) => r.groupName === 'stack (catalog)'
    );
    expect(stack?.matchFileNames).toContain('biome.json');
  });

  test('dependabot declines dep-updates', () => {
    const dir = project({ name: 'x' });
    mkdirSync(join(dir, '.github'));
    writeFileSync(join(dir, '.github/dependabot.yml'), 'version: 2\n');
    expect(stateOf(dir)).toMatchObject({ declined: true, reason: 'dependabot' });
  });

  test('a Renovate config in an alternative location declines dep-updates', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, '.renovaterc.json'), '{}');
    expect(stateOf(dir)).toMatchObject({ declined: true, reason: 'renovate (own config)' });
  });

  test('a renovate key in package.json declines dep-updates', () => {
    const dir = project({ name: 'x', renovate: { extends: ['config:recommended'] } });
    expect(stateOf(dir)).toMatchObject({ declined: true, reason: 'renovate (own config)' });
  });

  test('existing renovate.json in root: block active, file stays (create-only)', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'renovate.json'), '{"extends":["config:js-lib"]}\n');
    expect(stateOf(dir)?.declined).toBe(false);
    apply(dir, detectContext(dir), SYNC);
    expect(readFileSync(join(dir, 'renovate.json'), 'utf8')).toContain('config:js-lib');
  });
});

describe('biome $schema drift (doctor)', () => {
  const pinned = VERSIONS['@biomejs/biome'].replace(/^[\^~]/, '');

  test('biomeSchemaVersion reads the version from the $schema URL (else null)', () => {
    expect(biomeSchemaVersion('"$schema": "https://biomejs.dev/schemas/2.4.16/schema.json"')).toBe(
      '2.4.16'
    );
    expect(biomeSchemaVersion('{}')).toBeNull();
  });

  test('init produces biome.json with $schema == pinned biome version (no drift)', () => {
    const dir = project({ name: 'x' });
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(biomeSchemaVersion(readFileSync(join(dir, 'biome.json'), 'utf8'))).toBe(pinned);
  });

  test('stale $schema version: doctor warns but does not fail', () => {
    const dir = monorepo(true, {}); // known to be doctor-clean after init
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const biome = join(dir, 'biome.json');
    writeFileSync(biome, readFileSync(biome, 'utf8').replace(/schemas\/[^/]+\//, 'schemas/0.0.1/'));
    // drift is a warning (return 0), not a failure (return 1):
    expect(runDoctor({ cwd: dir, svelte: undefined, diff: false })).toBe(0);
  });
});

describe('prettier useTabs conflict (doctor)', () => {
  test('prettierUsesTabs detects useTabs:true (else false)', () => {
    expect(prettierUsesTabs('{"useTabs": true}')).toBe(true);
    expect(prettierUsesTabs('{"useTabs": false}')).toBe(false);
    expect(prettierUsesTabs('{}')).toBe(false);
    // regex fallback for a non-strict-JSON .prettierrc (comments/trailing comma)
    expect(prettierUsesTabs('{ "useTabs": true, /* tabs */ }')).toBe(true);
  });

  test('useTabs:true in .prettierrc: doctor warns but does not fail', () => {
    const dir = monorepo(true, {}); // svelte ui pkg ⇒ root .prettierrc; doctor-clean after init
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const rc = join(dir, '.prettierrc');
    writeFileSync(rc, readFileSync(rc, 'utf8').replace('"useTabs": false', '"useTabs": true'));
    // the conflict is a warning (return 0), not a failure (return 1):
    expect(runDoctor({ cwd: dir, svelte: undefined, diff: false })).toBe(0);
  });
});

describe('Renamed tool deps (bun-types → @types/bun)', () => {
  test('plans removal of the old name alongside the successor', () => {
    const ctx = detectContext(project({ name: 'x', devDependencies: { 'bun-types': '^1.3.0' } }));
    const plan = computePkgPlan(ctx);
    expect(plan.devDepsToAdd.some((d) => d.name === '@types/bun')).toBe(true);
    expect(plan.devDepsToRemove).toEqual([{ name: 'bun-types', from: '^1.3.0', to: '@types/bun' }]);
  });

  test('mutatePkg removes the old name and keeps the new one', () => {
    const ctx = detectContext(project({ name: 'x', devDependencies: { 'bun-types': '^1.3.0' } }));
    mutatePkg(ctx.pkg, computePkgPlan(ctx), false);
    expect(ctx.pkg.devDependencies?.['bun-types']).toBeUndefined();
    expect(ctx.pkg.devDependencies?.['@types/bun']).toBe(VERSIONS['@types/bun']);
  });

  test('a pinned old name is deliberately kept (udx pin bun-types)', () => {
    const ctx = detectContext(project({ name: 'x', devDependencies: { 'bun-types': '^1.3.0' } }));
    const plan = computePkgPlan(ctx, { pinned: new Set(['bun-types']) });
    expect(plan.devDepsToRemove).toHaveLength(0);
  });

  test('--only without the successor plans no removal (surgical)', () => {
    const ctx = detectContext(project({ name: 'x', devDependencies: { 'bun-types': '^1.3.0' } }));
    const plan = computePkgPlan(ctx, { only: { devDeps: new Set(['@biomejs/biome']) } });
    expect(plan.devDepsToRemove).toHaveLength(0);
  });

  test("catalog mode: the old name's catalog: reference is removed too", () => {
    const ctx = detectContext(
      project({
        name: 'x',
        workspaces: { catalog: { 'bun-types': '^1.3.0' } },
        devDependencies: { 'bun-types': 'catalog:' }
      })
    );
    const plan = computePkgPlan(ctx, {}, undefined, readCatalogTables(ctx.pkg));
    expect(plan.devDepsToRemove).toEqual([
      { name: 'bun-types', from: 'catalog:', to: '@types/bun' }
    ]);
  });

  test('sync writes the removal into package.json', () => {
    const dir = project({ name: 'x', devDependencies: { 'bun-types': '^1.3.0' } });
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['bun-types']).toBeUndefined();
    expect(pkg.devDependencies['@types/bun']).toBe(VERSIONS['@types/bun']);
  });
});

describe('Scope move (@urbicon/* → @urbicon-ui/*)', () => {
  /** A consumer set up before the move: old scope in the deps, config already rewired. */
  const legacyConsumer = (): string => {
    const dir = project({
      name: 'x',
      devDependencies: { '@urbicon/biome-config': '^0.2.9' }
    });
    // wiring must see the new name, otherwise the preset counts as self-managed and is skipped
    writeFileSync(
      join(dir, 'biome.json'),
      '{ "extends": ["@urbicon-ui/biome-config/biome-base.json"] }\n'
    );
    return dir;
  };

  test('every old-scope package maps to its @urbicon-ui successor', () => {
    for (const dep of URBICON_DEPS) {
      expect(RENAMED_FROM[dep]).toBe(dep.replace('@urbicon-ui/', '@urbicon/'));
    }
  });

  test('plans removal of the old scope alongside the successor', () => {
    const plan = computePkgPlan(detectContext(legacyConsumer()));
    expect(plan.devDepsToAdd.some((d) => d.name === '@urbicon-ui/biome-config')).toBe(true);
    expect(plan.devDepsToRemove).toContainEqual({
      name: '@urbicon/biome-config',
      from: '^0.2.9',
      to: '@urbicon-ui/biome-config'
    });
  });

  test('sync leaves no old-scope dep behind', () => {
    const dir = legacyConsumer();
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@urbicon/biome-config']).toBeUndefined();
    expect(pkg.devDependencies['@urbicon-ui/biome-config']).toBe(
      VERSIONS['@urbicon-ui/biome-config']
    );
  });
});

describe('resolveSelection (--only)', () => {
  const fileIds = new Set(FILE_TEMPLATES.map((t) => t.id));

  test('a capability id expands to file/scripts/devDeps', () => {
    const sel = resolveSelection(['git-hooks'], fileIds);
    expect(sel.files.has('lefthook')).toBe(true);
    expect(sel.scripts.has('prepare')).toBe(true);
    expect(sel.devDeps.has('lefthook')).toBe(true);
    expect(sel.unknown).toHaveLength(0);
  });

  test('a file id is taken directly', () => {
    const sel = resolveSelection(['cliff'], fileIds);
    expect(sel.files.has('cliff')).toBe(true);
    expect(sel.scripts.size).toBe(0);
  });

  test('unknown identifiers end up in unknown', () => {
    const sel = resolveSelection(['cliff', 'unsinn'], fileIds);
    expect(sel.files.has('cliff')).toBe(true);
    expect(sel.unknown).toEqual(['unsinn']);
  });
});

describe('applyFiles --only', () => {
  test('restricts writing to the selected file ids', () => {
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
    expect(existsSync(join(dir, 'biome.json'))).toBe(false); // not in the filter
    expect(res.every((r) => r.dest === 'cliff.toml')).toBe(true);
  });

  test('only + force writes exactly one locally modified file (interactive path)', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    const m = emptyManifest();
    applyFiles(dir, ctx, INIT, m); // creates cliff.toml + bump.sh
    writeFileSync(join(dir, 'cliff.toml'), '# lokal');
    writeFileSync(join(dir, 'scripts/bump.sh'), '# lokal bump');
    // targeted force-write only for cliff (like runInteractive on "update"):
    applyFiles(dir, ctx, { ...SYNC, force: true }, m, new Map(), new Set(['cliff']));
    expect(readFileSync(join(dir, 'cliff.toml'), 'utf8')).not.toBe('# lokal');
    expect(readFileSync(join(dir, 'scripts/bump.sh'), 'utf8')).toBe('# lokal bump'); // untouched
  });
});

describe('skip & adopt', () => {
  test('skip persists a manual decline, adopt reverts it', () => {
    const dir = project({ name: 'x' });
    expect(runSkip({ cwd: dir, dryRun: false, capability: 'git-hooks' })).toBe(0);
    expect(readManifest(dir).declined['git-hooks']).toBe('manual');
    expect(runAdopt({ cwd: dir, dryRun: false, capability: 'git-hooks' })).toBe(0);
    expect(readManifest(dir).declined['git-hooks']).toBeUndefined();
  });

  test('adopt overrides the auto-decline (lefthook despite husky)', () => {
    // husky present ⇒ git-hooks would be auto-declined; adopt makes it explicitly active.
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    expect(runAdopt({ cwd: dir, dryRun: false, capability: 'git-hooks' })).toBe(0);
    const m = readManifest(dir);
    expect(m.adopted).toContain('git-hooks');
    expect(m.declined['git-hooks']).toBeUndefined();
    // resolveCapabilities respects adopt even though husky is still present:
    const st = resolveCapabilities(detectContext(dir), m).find((s) => s.cap.id === 'git-hooks');
    expect(st?.declined).toBe(false);
  });

  test('skip undoes a previous adoption (adopt)', () => {
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    runAdopt({ cwd: dir, dryRun: false, capability: 'git-hooks' });
    runSkip({ cwd: dir, dryRun: false, capability: 'git-hooks' });
    const m = readManifest(dir);
    expect(m.adopted).not.toContain('git-hooks');
    expect(m.declined['git-hooks']).toBe('manual');
  });

  test('unknown building block → exit 2', () => {
    const dir = project({ name: 'x' });
    expect(runSkip({ cwd: dir, dryRun: false, capability: 'unsinn' })).toBe(2);
  });

  test('missing building block name → exit 2', () => {
    const dir = project({ name: 'x' });
    expect(runAdopt({ cwd: dir, dryRun: false, capability: undefined })).toBe(2);
  });

  test('skip --dry-run writes no manifest', () => {
    const dir = project({ name: 'x' });
    runSkip({ cwd: dir, dryRun: true, capability: 'git-hooks' });
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });
});

describe('add (dev-facing = adopt + targeted sync)', () => {
  const addFlags = (cwd: string, dryRun: boolean, capability: string | undefined) => ({
    ...HARNESS_DEFAULTS,
    cwd,
    dryRun,
    capability
  });

  test('sets up a building block directly (file + script + devDep), surgically', () => {
    const dir = project({ name: 'x' });
    expect(runAdd(addFlags(dir, false, 'git-hooks'))).toBe(0);
    expect(existsSync(join(dir, 'lefthook.yml'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts?.prepare).toBe('lefthook install');
    expect(pkg.devDependencies?.lefthook).toBeDefined();
    // only this building block — others stay untouched:
    expect(existsSync(join(dir, 'biome.json'))).toBe(false);
    expect(pkg.scripts?.bump).toBeUndefined();
    expect(readManifest(dir).adopted).toContain('git-hooks');
  });

  test('overrides the auto-decline (lefthook despite husky) and sets it up', () => {
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    expect(runAdd(addFlags(dir, false, 'git-hooks'))).toBe(0);
    expect(existsSync(join(dir, 'lefthook.yml'))).toBe(true);
    const m = readManifest(dir);
    expect(m.adopted).toContain('git-hooks');
    expect(m.declined['git-hooks']).toBeUndefined();
  });

  test('dry-run writes nothing — neither file nor manifest', () => {
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    expect(runAdd(addFlags(dir, true, 'git-hooks'))).toBe(0);
    expect(existsSync(join(dir, 'lefthook.yml'))).toBe(false);
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });

  test('unknown building block → exit 2, nothing written', () => {
    const dir = project({ name: 'x' });
    expect(runAdd(addFlags(dir, false, 'unsinn'))).toBe(2);
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });

  test('missing building block name → exit 2', () => {
    const dir = project({ name: 'x' });
    expect(runAdd(addFlags(dir, false, undefined))).toBe(2);
  });

  test('add --force does NOT overwrite an existing create-only config (additive)', () => {
    // eslint ⇒ lint-format auto-declined; add adopts it but leaves the project's own biome.json.
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

describe('installPlan (--install decision)', () => {
  test('changes + --install → run, do not offer', () => {
    expect(installPlan({ install: true, dryRun: false }, true)).toEqual({
      run: true,
      offer: false
    });
  });

  test('changes without --install → offer, do not run', () => {
    expect(installPlan({ install: false, dryRun: false }, true)).toEqual({
      run: false,
      offer: true
    });
  });

  test('no installable changes → neither run nor offer', () => {
    expect(installPlan({ install: true, dryRun: false }, false)).toEqual({
      run: false,
      offer: false
    });
    expect(installPlan({ install: false, dryRun: false }, false)).toEqual({
      run: false,
      offer: false
    });
  });

  test('dry-run never runs and never offers (even with --install + changes)', () => {
    expect(installPlan({ install: true, dryRun: true }, true)).toEqual({
      run: false,
      offer: false
    });
  });
});

describe('runHarness orchestration', () => {
  test('persists a fresh auto-decline into the manifest (without --only)', () => {
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(readManifest(dir).declined['git-hooks']).toBe('husky');
    expect(existsSync(join(dir, 'lefthook.yml'))).toBe(false);
    // on the follow-up run no longer 'fresh', but persisted:
    const st = resolveCapabilities(detectContext(dir), readManifest(dir)).find(
      (s) => s.cap.id === 'git-hooks'
    );
    expect(st).toMatchObject({ declined: true, fresh: false });
  });

  test('dry-run persists no auto-decline (no manifest)', () => {
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: true });
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });

  test('--only persists no auto-decline (surgical, no silent mutation)', () => {
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false, only: ['cliff'] });
    expect(readManifest(dir).declined['git-hooks']).toBeUndefined();
  });

  test('--only git-hooks patches only its script/devDep (surgical)', () => {
    const dir = project({ name: 'x' });
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false, only: ['git-hooks'] });
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts?.prepare).toBe('lefthook install');
    expect(pkg.devDependencies?.lefthook).toBeDefined();
    expect(pkg.scripts?.bump).toBeUndefined();
    expect(pkg.devDependencies?.['@biomejs/biome']).toBeUndefined();
    expect(existsSync(join(dir, 'biome.json'))).toBe(false);
  });

  test('--only with no match in a monorepo writes nothing (root + package aggregated)', () => {
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

  test('--only on an auto-declined building block stays skipped without adoption', () => {
    // husky ⇒ git-hooks is auto-declined; a targeted sync alone does NOT set it up.
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false, only: ['git-hooks'] });
    expect(existsSync(join(dir, 'lefthook.yml'))).toBe(false);
  });

  test('manifestOverride lifts the auto-decline in sync (foundation of runAdd)', () => {
    // This is exactly the path through which `udx add` makes the adoption visible even in dry-run.
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    const m: Manifest = { ...emptyManifest(), adopted: ['git-hooks'] };
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false, only: ['git-hooks'] }, m);
    expect(existsSync(join(dir, 'lefthook.yml'))).toBe(true);
    // the adoption is persisted by sync:
    expect(readManifest(dir).adopted).toContain('git-hooks');
  });
});

describe('Per-package Svelte tier (D9 WP1)', () => {
  const readPkg = (dir: string, rel = 'package.json') =>
    JSON.parse(readFileSync(join(dir, rel), 'utf8'));

  test('Svelte sub-package gets Svelte deps + svelte-flavored scripts (closes the gap)', () => {
    const dir = monorepo(); // non-svelte root, packages/ui = svelte
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const ui = readPkg(dir, 'packages/ui/package.json');
    for (const d of SVELTE_DEPS) expect(ui.devDependencies?.[d]).toBeDefined();
    expect(ui.scripts?.lint).toBe('biome check . && svelte-check --tsconfig ./tsconfig.json');
    expect(ui.scripts?.format).toBe('biome format --write . && prettier --write "**/*.svelte"');
    // repo-global scripts do NOT belong in the package (they run once at the root):
    expect(ui.scripts?.bump).toBeUndefined();
    expect(ui.scripts?.prepare).toBeUndefined();
    expect(ui.scripts?.fix).toBeUndefined();
  });

  test('root keeps non-svelte lint/format and gets no Svelte deps', () => {
    const dir = monorepo();
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const root = readPkg(dir);
    expect(root.scripts?.lint).toBe('biome check .');
    expect(root.scripts?.format).toBe('biome format --write .');
    expect(root.scripts?.bump).toBe('bash scripts/bump.sh patch'); // repo-global at the root
    expect(root.devDependencies?.['@biomejs/biome']).toBeDefined();
    for (const d of SVELTE_DEPS) expect(root.devDependencies?.[d]).toBeUndefined();
  });

  test('non-svelte root: root hook + Prettier config cover .svelte from sub-packages', () => {
    const dir = monorepo(); // non-svelte root, packages/ui = svelte
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    // lefthook.yml is root-scoped but must format `.svelte` from packages/ui:
    const lefthook = readFileSync(join(dir, 'lefthook.yml'), 'utf8');
    expect(lefthook).toContain("glob: '*.svelte'");
    expect(lefthook).toContain('bunx prettier --write');
    // … and the corresponding Prettier config lives at the root, else the hook runs without the Svelte plugin:
    expect(existsSync(join(dir, '.prettierrc'))).toBe(true);
    expect(existsSync(join(dir, '.prettierignore'))).toBe(true);
    // doctor sees no drift — the target (svelteAnywhere) matches what was written:
    expect(runDoctor({ cwd: dir, svelte: undefined, diff: false })).toBe(0);
  });

  test('status: in-sync root hook is not reported as stale (svelteAnywhere parity with sync)', () => {
    const dir = monorepo(); // non-svelte root, packages/ui = svelte
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    // buildReport must enrich the root ctx with svelteAnywhere just like sync; otherwise it renders the
    // hook without the Svelte prettier line, mismatches the (correctly written) file and reports drift.
    const lefthookRow = buildReport({ cwd: dir, svelte: undefined, json: false })
      .sections.find((s) => s.title === 'Files')
      ?.rows.find((r) => r.label === 'lefthook.yml');
    expect(lefthookRow?.state).toBe('sync');
  });

  test('renderLefthook: svelteAnywhere drives the prettier line, falls back to svelte otherwise', () => {
    const lefthook = FILE_TEMPLATES.find((t) => t.id === 'lefthook');
    if (!lefthook) throw new Error('lefthook template missing');
    const hasSveltePrettier = (ctx: { svelte: boolean; svelteAnywhere?: boolean }) =>
      lefthook.render({ projectName: 'x', ...ctx }).includes("glob: '*.svelte'");
    expect(hasSveltePrettier({ svelte: true })).toBe(true); // svelte root / single package
    expect(hasSveltePrettier({ svelte: false })).toBe(false); // plain TS
    expect(hasSveltePrettier({ svelte: false, svelteAnywhere: true })).toBe(true); // non-svelte root + svelte sub
    expect(hasSveltePrettier({ svelte: true, svelteAnywhere: false })).toBe(false); // svelteAnywhere takes precedence (??)
  });

  test('non-svelte TS package gets no devDeps of its own (Decision A, hoisting)', () => {
    const dir = monorepo();
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const api = readPkg(dir, 'packages/api/package.json'); // TS (src/), not svelte
    expect(api.devDependencies).toBeUndefined();
    // ... but does get the package-scoped tsconfig (existing behavior):
    expect(existsSync(join(dir, 'packages/api/tsconfig.json'))).toBe(true);
  });

  test('a second sync is idempotent (no renewed svelte package drift)', () => {
    const dir = monorepo();
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const before = readFileSync(join(dir, 'packages/ui/package.json'), 'utf8');
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(readFileSync(join(dir, 'packages/ui/package.json'), 'utf8')).toBe(before);
  });

  test('canonicalDevDeps/Scripts respect the tier', () => {
    const svelteCtx = detectContext(project({ name: 'u', devDependencies: { svelte: '^5' } }));
    const plainCtx = detectContext(project({ name: 'p' }));
    // svelte tier: only Svelte deps, and only in a Svelte context
    expect(Object.keys(canonicalDevDeps(svelteCtx, 'svelte')).sort()).toEqual(
      [...SVELTE_DEPS].sort()
    );
    expect(canonicalDevDeps(plainCtx, 'svelte')).toEqual({});
    // root tier: never Svelte
    for (const d of SVELTE_DEPS) expect(canonicalDevDeps(svelteCtx, 'root')[d]).toBeUndefined();
    expect(canonicalDevDeps(svelteCtx, 'root')['@biomejs/biome']).toBeDefined();
    // no tier = previous behavior (Svelte included)
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

describe('Catalog model (D9 WP2)', () => {
  test('readCatalogTables: object form with catalog → tables', () => {
    const t = readCatalogTables({ workspaces: { catalog: { '@biomejs/biome': '^2.4.0' } } });
    expect(t?.default['@biomejs/biome']).toBe('^2.4.0');
    expect(t?.named).toEqual({});
  });

  test('readCatalogTables: array form → null (no catalog: possible)', () => {
    expect(readCatalogTables({ workspaces: ['packages/*'] })).toBeNull();
  });

  test('readCatalogTables: object form without catalog/catalogs → null (no catalog-first)', () => {
    expect(readCatalogTables({ workspaces: { packages: ['packages/*'] } })).toBeNull();
  });

  test('readCatalogTables: no workspaces → null', () => {
    expect(readCatalogTables({ name: 'x' })).toBeNull();
  });

  test('readCatalogTables: named catalogs', () => {
    const t = readCatalogTables({
      workspaces: { catalogs: { svelte: { 'svelte-check': '^4.0.0' } } }
    });
    expect(t?.named.svelte?.['svelte-check']).toBe('^4.0.0');
    expect(t?.default).toEqual({});
  });

  test('selectCatalogTable: default hit / named hit / nowhere', () => {
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

  test('raise: operator-preserving, floor maximum, never a downgrade', () => {
    expect(raise('^2.3.0', '^2.4.16')).toBe('^2.4.16'); // bumped, ^ stays
    expect(raise('^2.5.0', '^2.4.16')).toBe('^2.5.0'); // current higher → stays (no downgrade)
    expect(raise('~1.2.0', '^1.5.0')).toBe('~1.5.0'); // ~ is preserved
    expect(raise('>=2.0.0', '^3.0.0')).toBe('>=3.0.0'); // >= is preserved
    expect(raise('^1.0.0', '^1.0.0')).toBe('^1.0.0'); // idempotent (same floor)
    expect(raise('catalog:', '^1.0.0')).toBe('catalog:'); // protocol → unchanged
    expect(raise('*', '^1.0.0')).toBe('*'); // not comparable → unchanged
    expect(raise('^1.2.3+build.5', '^1.0.0')).toBe('^1.2.3+build.5'); // higher → unchanged (build metadata stays)
    // compound / leading-`<` ranges are not unambiguously raisable → just use the (pin) target:
    expect(raise('>=2.0.0 <3.0.0', '^3.5.0')).toBe('^3.5.0');
    expect(raise('<3.0.0 >=2.0.0', '^2.5.0')).toBe('^2.5.0');
  });
});

describe('computePkgPlan catalog mode (D9 WP2)', () => {
  const biome = VERSIONS['@biomejs/biome']; // pin, by convention `^x.y.z`
  const only = (dep: string) => ({ only: { devDeps: new Set([dep]) } });
  const empty = { default: {}, named: {} };

  test('missing entry: creates a catalog entry + switches the devDep to catalog:', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@biomejs/biome': '^2.3.0' } })
    );
    const plan = computePkgPlan(ctx, only('@biomejs/biome'), undefined, empty);
    expect(plan.catalogEntriesToAdd).toEqual([{ name: '@biomejs/biome', table: null, to: biome }]);
    expect(plan.devDepsToCatalog).toEqual([
      { name: '@biomejs/biome', from: '^2.3.0', to: 'catalog:' }
    ]);
    expect(plan.devDepsDrift).toEqual([]); // no literal drift in catalog mode
  });

  test('current entry, literal devDep → switch only, no drift', () => {
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

  test('entry behind pin → drift raises it (devDep already catalog:)', () => {
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
    expect(plan.devDepsToCatalog).toEqual([]); // devDep already correct
  });

  test('entry newer than pin → no drift', () => {
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

  test('@urbicon-ui/* stay literal (never in the catalog)', () => {
    const ctx = detectContext(project({ name: 'x' }));
    const plan = computePkgPlan(ctx, only('@urbicon-ui/tsconfig'), undefined, empty);
    expect(plan.catalogEntriesToAdd).toEqual([]);
    expect(plan.devDepsToCatalog).toEqual([]);
    expect(plan.devDepsToAdd).toEqual([
      { name: '@urbicon-ui/tsconfig', to: VERSIONS['@urbicon-ui/tsconfig'] }
    ]);
  });

  test('pinned dep: no switch, no entry, only reported as pinned', () => {
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

  test('literal devDep newer than pin, entry missing → entry = maximum (no downgrade, D9-E)', () => {
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

  test('a named catalog (catalogs.svelte) is used instead of the default', () => {
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
    expect(plan.catalogEntriesToAdd).toEqual([]); // already in the named catalog
  });

  test('devDep catalog: but entry missing → entry is added (repairs a broken state)', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@biomejs/biome': 'catalog:' } })
    );
    const plan = computePkgPlan(ctx, only('@biomejs/biome'), undefined, empty);
    expect(plan.catalogEntriesToAdd).toEqual([{ name: '@biomejs/biome', table: null, to: biome }]);
    expect(plan.devDepsToCatalog).toEqual([]);
    expect(plan.devDepsToAdd).toEqual([]);
  });

  test('entry older than literal devDep → drift to maximum + switch at once (D9-E)', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@biomejs/biome': '^2.6.0' } })
    );
    const plan = computePkgPlan(ctx, only('@biomejs/biome'), undefined, {
      default: { '@biomejs/biome': '^2.0.0' },
      named: {}
    });
    // entry ^2.0.0 behind the pin AND behind the literal devDep ^2.6.0 → raise to the maximum.
    expect(plan.catalogEntriesDrift).toEqual([
      { name: '@biomejs/biome', table: null, from: '^2.0.0', to: '^2.6.0' }
    ]);
    expect(plan.devDepsToCatalog).toEqual([
      { name: '@biomejs/biome', from: '^2.6.0', to: 'catalog:' }
    ]);
  });

  test('invariant: every catalog: devDep in the plan has an existing/planned entry', () => {
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

describe('Catalog writes via runHarness (D9 WP3)', () => {
  const readPkg = (dir: string, rel = 'package.json') =>
    JSON.parse(readFileSync(join(dir, rel), 'utf8'));

  test('catalog monorepo init: root carries tool deps as catalog: + maintains the entries', () => {
    const dir = monorepo(true, {}); // empty default catalog ⇒ catalog mode
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const root = readPkg(dir);
    expect(root.devDependencies['@biomejs/biome']).toBe('catalog:');
    expect(root.devDependencies.typescript).toBe('catalog:');
    expect(root.workspaces.catalog['@biomejs/biome']).toBe(VERSIONS['@biomejs/biome']);
    expect(root.workspaces.catalog.typescript).toBe(VERSIONS.typescript);
    // @urbicon-ui/* stay literal (D9-D), never in the catalog:
    expect(root.devDependencies['@urbicon-ui/tsconfig']).toBe(VERSIONS['@urbicon-ui/tsconfig']);
    expect(root.workspaces.catalog['@urbicon-ui/tsconfig']).toBeUndefined();
    // workspaces.packages stays intact:
    expect(root.workspaces.packages).toEqual(['packages/*']);
  });

  test('atomicity: every catalog: devDep has a catalog entry (bun install would resolve)', () => {
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

  test('svelte package carries Svelte deps as catalog:, entry in the root catalog; api without devDeps', () => {
    const dir = monorepo(true, {});
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(readPkg(dir, 'packages/ui/package.json').devDependencies['svelte-check']).toBe(
      'catalog:'
    );
    expect(readPkg(dir).workspaces.catalog['svelte-check']).toBe(VERSIONS['svelte-check']);
    expect(readPkg(dir, 'packages/api/package.json').devDependencies).toBeUndefined(); // Decision A
  });

  test('two svelte packages, different versions → catalog = maximum, no downgrade', () => {
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
    // catalog = maximum across both packages (^99.0.0) — no downgrade for admin:
    expect(readPkg(dir).workspaces.catalog['svelte-check']).toBe('^99.0.0');
    expect(readPkg(dir, 'packages/ui/package.json').devDependencies['svelte-check']).toBe(
      'catalog:'
    );
    expect(readPkg(dir, 'packages/admin/package.json').devDependencies['svelte-check']).toBe(
      'catalog:'
    );
  });

  test('single package with catalog: devDeps → catalog:, entries maintained', () => {
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

  test('dry-run in catalog mode writes nothing', () => {
    const dir = monorepo(true, {});
    const before = readFileSync(join(dir, 'package.json'), 'utf8');
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: true });
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before);
  });

  test('a second sync is idempotent (catalog mode, root + package)', () => {
    const dir = monorepo(true, {});
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const before = readFileSync(join(dir, 'package.json'), 'utf8');
    const beforeUi = readFileSync(join(dir, 'packages/ui/package.json'), 'utf8');
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before);
    expect(readFileSync(join(dir, 'packages/ui/package.json'), 'utf8')).toBe(beforeUi);
  });

  test('array-form monorepo stays literal (no catalog possible), gap still closed', () => {
    const dir = monorepo(); // array form, no catalog
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const root = readPkg(dir);
    expect(root.devDependencies['@biomejs/biome']).toBe(VERSIONS['@biomejs/biome']); // literal
    expect(root.workspaces.catalog).toBeUndefined();
    expect(readPkg(dir, 'packages/ui/package.json').devDependencies['svelte-check']).toBe(
      VERSIONS['svelte-check']
    ); // literal per package → gap closed without a catalog
  });

  test('named consumer catalog is used (catalog:svelte); foreign entries stay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'udx-named-'));
    // default catalog with one unmanaged entry (react) + named svelte catalog (svelte-check).
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
    // svelte-check is maintained in the NAMED catalog (not moved into the default):
    expect(root.workspaces.catalogs.svelte['svelte-check']).toBe(VERSIONS['svelte-check']);
    expect(root.workspaces.catalog['svelte-check']).toBeUndefined();
    expect(readPkg(dir, 'packages/ui/package.json').devDependencies['svelte-check']).toBe(
      'catalog:svelte'
    );
    // foreign, unmanaged entry stays untouched:
    expect(root.workspaces.catalog.react).toBe('^18.0.0');
  });

  test('pinned dep stays literal in catalog mode (no switch, no catalog entry)', () => {
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
    expect(root.devDependencies['@biomejs/biome']).toBe('^2.0.0'); // pinned, not catalog:
    expect(root.workspaces.catalog['@biomejs/biome']).toBeUndefined(); // no entry
    expect(root.devDependencies.typescript).toBe('catalog:'); // unpinned tool dep is catalog:
  });
});

describe('computePkgPlan', () => {
  test('missing scripts & devDeps are planned', () => {
    const plan = computePkgPlan(detectContext(project({ name: 'x' })));
    expect(plan.scriptsToAdd.some((s) => s.name === 'bump')).toBe(true);
    expect(plan.devDepsToAdd.some((d) => d.name === '@biomejs/biome')).toBe(true);
  });

  test('existing script with a different value = drift', () => {
    const plan = computePkgPlan(
      detectContext(project({ name: 'x', scripts: { lint: 'eslint .' } }))
    );
    expect(plan.scriptsDrift.some((s) => s.name === 'lint')).toBe(true);
  });

  test('svelte plans svelte-check + prettier deps', () => {
    const plan = computePkgPlan(
      detectContext(project({ name: 'x', devDependencies: { svelte: '^5' } }))
    );
    expect(plan.devDepsToAdd.some((d) => d.name === 'svelte-check')).toBe(true);
    expect(plan.devDepsToAdd.some((d) => d.name === 'prettier-plugin-svelte')).toBe(true);
  });

  test('workspace:* devDep counts as satisfied (no drift)', () => {
    const plan = computePkgPlan(
      detectContext(project({ name: 'x', devDependencies: { '@biomejs/biome': 'workspace:*' } }))
    );
    expect(plan.devDepsToAdd.some((d) => d.name === '@biomejs/biome')).toBe(false);
    expect(plan.devDepsDrift.some((d) => d.name === '@biomejs/biome')).toBe(false);
  });

  test('a newer compatible devDep version is not drift (no downgrade)', () => {
    // A patch version higher than the pin satisfies the baseline ⇒ udx leaves it alone.
    const [maj, min, patch] = VERSIONS['@types/node'].replace('^', '').split('.').map(Number);
    const newer = `^${maj}.${min}.${(patch as number) + 1}`;
    const plan = computePkgPlan(
      detectContext(project({ name: 'x', devDependencies: { '@types/node': newer } }))
    );
    expect(plan.devDepsToAdd.some((d) => d.name === '@types/node')).toBe(false);
    expect(plan.devDepsDrift.some((d) => d.name === '@types/node')).toBe(false);
  });

  test('an older devDep version is drift (project is behind the pin)', () => {
    const plan = computePkgPlan(
      detectContext(project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } }))
    );
    expect(plan.devDepsDrift.some((d) => d.name === '@types/node')).toBe(true);
  });
});

describe('satisfiesPin', () => {
  test('a newer compatible version satisfies the pin (no downgrade)', () => {
    expect(satisfiesPin('^25.9.2', '^25.9.1')).toBe(true);
    expect(satisfiesPin('^26.0.0', '^25.9.1')).toBe(true); // higher major stays untouched
  });

  test('the same floor satisfies the pin', () => {
    expect(satisfiesPin('^0.1.4', '^0.1.4')).toBe(true);
  });

  test('an older version does not satisfy the pin (= drift)', () => {
    expect(satisfiesPin('^0.1.2', '^0.1.4')).toBe(false);
    expect(satisfiesPin('~1.2.3', '^1.3.0')).toBe(false);
  });

  test('workspace:/catalog: count as satisfied (version governed elsewhere)', () => {
    expect(satisfiesPin('workspace:*', '^2.4.16')).toBe(true);
    expect(satisfiesPin('catalog:', '^25.9.1')).toBe(true);
  });

  test('a non-comparable range counts as satisfied (no risky downgrade)', () => {
    expect(satisfiesPin('github:foo/bar', '^1.0.0')).toBe(true);
    expect(satisfiesPin('*', '^1.0.0')).toBe(true);
  });

  test('a compound range uses the floor, regardless of token order', () => {
    expect(satisfiesPin('>=2.0.0 <3.0.0', '^2.5.0')).toBe(false); // floor 2.0.0 < pin
    expect(satisfiesPin('<3.0.0 >=2.0.0', '^2.5.0')).toBe(false); // upper bound first → still 2.0.0
    expect(satisfiesPin('>=2.6.0 <3.0.0', '^2.5.0')).toBe(true); // floor 2.6.0 ≥ pin
  });

  test('a tilde range with the same floor satisfies the pin', () => {
    expect(satisfiesPin('~1.3.0', '^1.3.0')).toBe(true);
  });

  test('npm: alias / git URL with an embedded version count as satisfied (different package)', () => {
    expect(satisfiesPin('npm:@biomejs/biome@^2.5.0', '^2.4.16')).toBe(true);
    expect(satisfiesPin('git+https://x/y#v1.0.0', '^9.9.9')).toBe(true);
  });
});

describe('mutatePkg', () => {
  test('adds missing scripts/devDeps and sorts devDeps alphabetically', () => {
    const ctx = detectContext(project({ name: 'x' }));
    const changed = mutatePkg(ctx.pkg, computePkgPlan(ctx), false);
    expect(changed).toBe(true);
    expect(ctx.pkg.scripts?.bump).toBe('bash scripts/bump.sh patch');
    const keys = Object.keys(ctx.pkg.devDependencies ?? {});
    expect(keys).toContain('@biomejs/biome');
    expect(keys).toEqual([...keys].sort());
  });

  test('without force, script drift is preserved', () => {
    const ctx = detectContext(project({ name: 'x', scripts: { lint: 'eslint .' } }));
    mutatePkg(ctx.pkg, computePkgPlan(ctx), false);
    expect(ctx.pkg.scripts?.lint).toBe('eslint .');
  });

  test('with force, script drift is set to the canonical value', () => {
    const ctx = detectContext(project({ name: 'x', scripts: { lint: 'eslint .' } }));
    mutatePkg(ctx.pkg, computePkgPlan(ctx), true);
    expect(ctx.pkg.scripts?.lint).toBe('biome check .');
  });

  test('version drift (project behind pin) is raised without force — scripts are not', () => {
    const ctx = detectContext(
      project({
        name: 'x',
        devDependencies: { '@types/node': '^25.0.0' },
        scripts: { lint: 'eslint .' }
      })
    );
    mutatePkg(ctx.pkg, computePkgPlan(ctx), false); // NO force
    expect(ctx.pkg.devDependencies?.['@types/node']).toBe(VERSIONS['@types/node']); // raised
    expect(ctx.pkg.scripts?.lint).toBe('eslint .'); // script drift stays (force-only)
  });
});

describe('pin/unpin & safe raising', () => {
  test('a pinned devDep ends up in devDepsPinned, not in drift/add', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } })
    );
    const plan = computePkgPlan(ctx, { pinned: new Set(['@types/node']) });
    expect(plan.devDepsDrift.some((d) => d.name === '@types/node')).toBe(false);
    expect(plan.devDepsToAdd.some((d) => d.name === '@types/node')).toBe(false);
    expect(plan.devDepsPinned.some((d) => d.name === '@types/node')).toBe(true);
  });

  test('a pinned but missing devDep is reported, not added (hands-off, never silent)', () => {
    const ctx = detectContext(project({ name: 'x' })); // @types/node not installed
    const plan = computePkgPlan(ctx, { pinned: new Set(['@types/node']) });
    expect(plan.devDepsToAdd.some((d) => d.name === '@types/node')).toBe(false);
    expect(plan.devDepsPinned.some((d) => d.name === '@types/node' && d.from === undefined)).toBe(
      true
    );
  });

  test('mutatePkg leaves a pinned devDep untouched even with force', () => {
    const ctx = detectContext(
      project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } })
    );
    mutatePkg(ctx.pkg, computePkgPlan(ctx, { pinned: new Set(['@types/node']) }), true);
    expect(ctx.pkg.devDependencies?.['@types/node']).toBe('^25.0.0');
  });

  test('manifest persists pinned roundtrip', () => {
    const dir = project({ name: 'x' });
    writeManifest(dir, { ...emptyManifest(), pinned: { '@types/node': '^25.0.0' } }, false);
    expect(readManifest(dir).pinned).toEqual({ '@types/node': '^25.0.0' });
  });

  test('pin holds the current range, unpin releases it', () => {
    const dir = project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } });
    expect(runPin({ cwd: dir, dryRun: false, dep: '@types/node' })).toBe(0);
    expect(readManifest(dir).pinned['@types/node']).toBe('^25.0.0');
    expect(runUnpin({ cwd: dir, dryRun: false, dep: '@types/node' })).toBe(0);
    expect(readManifest(dir).pinned['@types/node']).toBeUndefined();
  });

  test('pin with an explicit range; without range & without installation → exit 2', () => {
    const dir = project({ name: 'x' });
    expect(runPin({ cwd: dir, dryRun: false, dep: 'foo', range: '^1.2.3' })).toBe(0);
    expect(readManifest(dir).pinned.foo).toBe('^1.2.3');
    expect(runPin({ cwd: dir, dryRun: false, dep: 'bar' })).toBe(2);
    expect(runPin({ cwd: dir, dryRun: false, dep: undefined })).toBe(2);
  });

  test('sync bumps a devDep behind the pin without --force', () => {
    const dir = project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } });
    runHarness('sync', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@types/node']).toBe(VERSIONS['@types/node']);
  });

  test('a pinned devDep stays untouched on sync', () => {
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

  test('fresh project: all files missing', () => {
    const rows = rowsOf(project({ name: 'x' }), 'Files');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.state === 'missing')).toBe(true);
  });

  test('behind devDep → state behind with udx sync command', () => {
    const dir = project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } });
    const row = rowsOf(dir, 'package.json', false).find((r) => r.label === '@types/node');
    expect(row?.state).toBe('behind');
    expect(row?.cmd).toBe('udx sync');
  });

  test('husky project → git-hooks declined row with add command', () => {
    const dir = project({ name: 'x', devDependencies: { husky: '^9' } });
    const row = rowsOf(dir, 'Building blocks').find((r) => r.cmd?.includes('git-hooks'));
    expect(row?.state).toBe('declined');
    expect(row?.cmd).toBe('udx add git-hooks');
  });

  test('pinned devDep → state pinned with unpin command', () => {
    const dir = project({ name: 'x', devDependencies: { '@types/node': '^25.0.0' } });
    runPin({ cwd: dir, dryRun: false, dep: '@types/node' });
    const row = rowsOf(dir, 'package.json', false).find((r) => r.label === '@types/node');
    expect(row?.state).toBe('pinned');
    expect(row?.cmd).toBe('udx unpin @types/node');
  });

  test('runStatus returns 0 (table & json)', () => {
    const dir = project({ name: 'x' });
    expect(runStatus({ cwd: dir, svelte: false, json: false })).toBe(0);
    expect(runStatus({ cwd: dir, svelte: false, json: true })).toBe(0);
  });
});

describe('Catalog reporting in status/doctor (D9 WP4)', () => {
  const rowsOf = (cwd: string, title: string) =>
    buildReport({ cwd, svelte: undefined, json: false }).sections.find((s) => s.title === title)
      ?.rows ?? [];
  const writePkg = (dir: string, mut: (p: Record<string, unknown>) => void) => {
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    mut(p);
    writeFileSync(join(dir, 'package.json'), JSON.stringify(p));
  };

  test('status: catalog section reports a missing entry + package.json the catalog: switch', () => {
    const dir = monorepo(true, {});
    writePkg(dir, (p) => {
      p.devDependencies = { '@biomejs/biome': '^2.0.0' };
    });
    expect(rowsOf(dir, 'Catalog').find((r) => r.label === '@biomejs/biome')?.state).toBe('missing');
    const sw = rowsOf(dir, 'package.json').find((r) => r.label === '@biomejs/biome');
    expect(sw?.state).toBe('behind');
    expect(sw?.detail).toContain('catalog:');
  });

  test('status: catalog drift (entry behind pin) → behind in the catalog section', () => {
    const dir = monorepo(true, { '@biomejs/biome': '^2.0.0' });
    writePkg(dir, (p) => {
      p.devDependencies = { '@biomejs/biome': 'catalog:' };
    });
    const row = rowsOf(dir, 'Catalog').find((r) => r.label === '@biomejs/biome');
    expect(row?.state).toBe('behind');
    expect(row?.detail).toContain('^2.0.0 →');
  });

  test('status: catalog entries deduplicated across svelte packages (svelte-check only once)', () => {
    const dir = monorepo(true, {});
    mkdirSync(join(dir, 'packages/admin'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/admin/package.json'),
      JSON.stringify({ name: 'admin', devDependencies: { svelte: '^5' } })
    );
    expect(rowsOf(dir, 'Catalog').filter((r) => r.label === 'svelte-check').length).toBe(1);
  });

  test('status: literal monorepo shows no catalog section', () => {
    expect(rowsOf(monorepo(), 'Catalog')).toEqual([]);
  });

  test('doctor: catalog consumer in sync after init (catalog: + entries detected correctly)', () => {
    const dir = monorepo(true, {});
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(runDoctor({ cwd: dir, svelte: undefined, diff: false })).toBe(0);
  });

  test('doctor: catalog: devDep without an entry → fail (missing catalog entry)', () => {
    const dir = monorepo(true, {});
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    writePkg(dir, (p) => {
      delete (p.workspaces as { catalog: Record<string, string> }).catalog['@biomejs/biome'];
    });
    expect(runDoctor({ cwd: dir, svelte: undefined, diff: false })).toBe(1);
  });

  test('status: a dep switched to catalog: is not counted twice (switch ≠ "in sync")', () => {
    const biome = VERSIONS['@biomejs/biome'];
    const dir = project({
      name: 'solo',
      workspaces: { catalog: { '@biomejs/biome': biome, typescript: VERSIONS.typescript } },
      devDependencies: { '@biomejs/biome': biome, typescript: 'catalog:' }
    });
    const rows = rowsOf(dir, 'package.json');
    expect(rows.find((r) => r.label === '@biomejs/biome')?.state).toBe('behind'); // switch row
    expect(rows.find((r) => r.label === 'typescript')).toBeUndefined(); // already catalog: → in sync
    // typescript counts as "in sync", biome (switch) does NOT — otherwise this would read "2 more".
    expect(rows.find((r) => r.detail.includes('in sync'))?.label).toBe('1 more');
  });

  test('status: catalog drift target is the maximum across svelte packages (accumulation like sync)', () => {
    const dir = monorepo(true, { 'svelte-check': '^4.0.0' });
    // packages/admin (alphabetically first) holds the LOWER version → without accumulation,
    // status would wrongly report admin's target instead of the effective maximum (^4.5.0 from ui).
    writeFileSync(
      join(dir, 'packages/ui/package.json'),
      JSON.stringify({ name: 'ui', devDependencies: { svelte: '^5', 'svelte-check': '^4.5.0' } })
    );
    mkdirSync(join(dir, 'packages/admin'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/admin/package.json'),
      JSON.stringify({ name: 'admin', devDependencies: { svelte: '^5', 'svelte-check': '^4.1.0' } })
    );
    const row = rowsOf(dir, 'Catalog').find((r) => r.label === 'svelte-check');
    expect(row?.state).toBe('behind');
    expect(row?.detail).toBe('^4.0.0 → ^4.5.0');
  });
});

describe('Wiring', () => {
  const statusOf = (dir: string, id: string) =>
    detectWiring(detectContext(dir)).find((s) => s.id === id)?.status;

  test('absent: without a consuming config', () => {
    const dir = project({ name: 'x' });
    expect(statusOf(dir, 'commitlint')).toBe('absent');
    expect(statusOf(dir, 'biome')).toBe('absent');
    expect(statusOf(dir, 'tsconfig')).toBe('absent');
  });

  test('wired: config references the @urbicon-ui package', () => {
    const dir = project({ name: 'x' });
    writeFileSync(
      join(dir, 'biome.json'),
      JSON.stringify({ extends: ['@urbicon-ui/biome-config/biome-base.json'] })
    );
    writeFileSync(
      join(dir, 'commitlint.config.mjs'),
      "import { createConfig } from '@urbicon-ui/commitlint-config';\n"
    );
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ extends: '@urbicon-ui/tsconfig/base.json' })
    );
    expect(statusOf(dir, 'biome')).toBe('wired');
    expect(statusOf(dir, 'commitlint')).toBe('wired');
    expect(statusOf(dir, 'tsconfig')).toBe('wired');
  });

  test('self-managed: config exists but does not reference @urbicon-ui', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'biome.json'), JSON.stringify({ extends: ['./eigene.json'] }));
    writeFileSync(
      join(dir, 'commitlint.config.mjs'),
      "export default { extends: ['@commitlint/config-conventional'] };\n"
    );
    expect(statusOf(dir, 'biome')).toBe('self-managed');
    expect(statusOf(dir, 'commitlint')).toBe('self-managed');
  });

  test('commitlint also finds other extensions (.js/.cjs/.ts)', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'commitlint.config.js'), "module.exports = { extends: ['x'] };\n");
    expect(statusOf(dir, 'commitlint')).toBe('self-managed');
  });

  test('tsconfig in a monorepo: wired when a package extends @urbicon-ui/tsconfig', () => {
    const dir = monorepo();
    writeFileSync(
      join(dir, 'packages/api/tsconfig.json'),
      JSON.stringify({ extends: '@urbicon-ui/tsconfig/base.json' })
    );
    expect(statusOf(dir, 'tsconfig')).toBe('wired');
  });

  test('tsconfig in a monorepo: self-managed when no tsconfig extends @urbicon-ui', () => {
    const dir = monorepo();
    writeFileSync(join(dir, 'packages/api/tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
    expect(statusOf(dir, 'tsconfig')).toBe('self-managed');
  });

  test('wiringSkipDeps skips only self-managed (not absent)', () => {
    const dir = project({ name: 'x' });
    writeFileSync(
      join(dir, 'commitlint.config.mjs'),
      "export default { extends: ['@commitlint/config-conventional'] };\n"
    );
    const skip = wiringSkipDeps(detectWiring(detectContext(dir)));
    expect(skip.has('@urbicon-ui/commitlint-config')).toBe(true); // self-managed
    expect(skip.has('@urbicon-ui/biome-config')).toBe(false); // absent ⇒ no skip
  });

  test('gating: self-managed config → @urbicon-ui dep is not "missing" but a wiring row', () => {
    const dir = project({ name: 'x' });
    writeFileSync(
      join(dir, 'commitlint.config.mjs'),
      "export default { extends: ['@commitlint/config-conventional'] };\n"
    );
    const report = buildReport({ cwd: dir, svelte: false, json: false });
    const pkgRows = report.sections.find((s) => s.title === 'package.json')?.rows ?? [];
    expect(pkgRows.some((r) => r.label === '@urbicon-ui/commitlint-config')).toBe(false);
    const wiringRows = report.sections.find((s) => s.title === 'Wiring')?.rows ?? [];
    const row = wiringRows.find((r) => r.label === 'commitlint.config.mjs');
    expect(row?.state).toBe('unwired');
    expect(row?.cmd).toBe('udx sync --only commitlint --force');
  });
});

describe('applyFiles create-only replacement (--only + --force)', () => {
  test('--only + --force replaces an existing create-only file with the template', () => {
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
      '@urbicon-ui/commitlint-config'
    );
    expect(res.find((r) => r.id === 'commitlint')?.action).toBe('updated');
  });

  test('--only without --force leaves the create-only file untouched', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'commitlint.config.mjs'), '// eigene\n');
    applyFiles(dir, detectContext(dir), SYNC, emptyManifest(), new Map(), new Set(['commitlint']));
    expect(readFileSync(join(dir, 'commitlint.config.mjs'), 'utf8')).toBe('// eigene\n');
  });

  test('bare --force (without --only) leaves create-only untouched (safety guarantee)', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    writeFileSync(join(dir, 'commitlint.config.mjs'), '// eigene\n');
    applyFiles(dir, ctx, { ...SYNC, force: true }, emptyManifest());
    expect(readFileSync(join(dir, 'commitlint.config.mjs'), 'utf8')).toBe('// eigene\n');
  });
});

describe('pruneLegacyRegistry', () => {
  /** Exactly the block udx ≤0.2.9 wrote into consumer projects. */
  const legacyBlock =
    "# @urbicon packages from Codeberg's public registry — no token needed to install.\n" +
    `[install.scopes]\n"@urbicon" = "${LEGACY_REGISTRY}"\n`;

  test('stays silent when there is no bunfig.toml', () => {
    expect(pruneLegacyRegistry(project({ name: 'x' }), false)).toBeNull();
  });

  test('stays silent for a bunfig.toml without the legacy registry', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'bunfig.toml'), '[test]\ncoverage = true\n');
    expect(pruneLegacyRegistry(dir, false)).toBeNull();
  });

  test('removes the file when the legacy block was all it contained', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'bunfig.toml'), legacyBlock);
    expect(pruneLegacyRegistry(dir, false)?.action).toBe('updated');
    expect(existsSync(join(dir, 'bunfig.toml'))).toBe(false);
  });

  test('keeps unrelated settings and drops only the legacy block', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'bunfig.toml'), `[test]\ncoverage = true\n\n${legacyBlock}`);
    expect(pruneLegacyRegistry(dir, false)?.action).toBe('updated');
    const content = readFileSync(join(dir, 'bunfig.toml'), 'utf8');
    expect(content).toContain('coverage = true');
    expect(content).not.toContain(LEGACY_REGISTRY);
    expect(content).not.toContain('[install.scopes]');
  });

  // Bun accepts an inline table for a scope; hand-written bunfig.toml files use it, so the
  // string form alone would silently leave the mapping in place.
  test('removes the inline-table spelling and keeps other [install] settings', () => {
    const dir = project({ name: 'x' });
    writeFileSync(
      join(dir, 'bunfig.toml'),
      `[install]\nlinker = "hoisted"\n\n[install.scopes]\n"@urbicon" = { url = "${LEGACY_REGISTRY}" }\n`
    );
    expect(pruneLegacyRegistry(dir, false)?.action).toBe('updated');
    const content = readFileSync(join(dir, 'bunfig.toml'), 'utf8');
    expect(content).toContain('linker = "hoisted"');
    expect(content).not.toContain(LEGACY_REGISTRY);
    expect(content).not.toContain('[install.scopes]');
  });

  test('removes an inline table carrying a token field', () => {
    const dir = project({ name: 'x' });
    writeFileSync(
      join(dir, 'bunfig.toml'),
      `[install.scopes]\n"@urbicon" = { token = "$TOK", url = "${LEGACY_REGISTRY}" }\n`
    );
    expect(pruneLegacyRegistry(dir, false)?.action).toBe('updated');
    expect(existsSync(join(dir, 'bunfig.toml'))).toBe(false);
  });

  test('an unmatched spelling is reported, never claimed as written', () => {
    const dir = project({ name: 'x' });
    // URL present, but split across lines — no pattern can safely rewrite this.
    const odd = `[install.scopes]\n"@urbicon" = {\n  url = "${LEGACY_REGISTRY}"\n}\n`;
    writeFileSync(join(dir, 'bunfig.toml'), odd);
    const res = pruneLegacyRegistry(dir, false);
    expect(res?.action).toBe('skipped');
    expect(readFileSync(join(dir, 'bunfig.toml'), 'utf8')).toBe(odd);
  });

  test('drops only its own line from a shared install.scopes block', () => {
    const dir = project({ name: 'x' });
    writeFileSync(
      join(dir, 'bunfig.toml'),
      `[install.scopes]\n"@other" = "https://example.com/"\n"@urbicon" = "${LEGACY_REGISTRY}"\n`
    );
    expect(pruneLegacyRegistry(dir, false)?.action).toBe('updated');
    const content = readFileSync(join(dir, 'bunfig.toml'), 'utf8');
    expect(content).toContain('[install.scopes]');
    expect(content).toContain('"@other"');
    expect(content).not.toContain(LEGACY_REGISTRY);
  });

  test('is idempotent — a second run has nothing left to do', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'bunfig.toml'), `[test]\ncoverage = true\n\n${legacyBlock}`);
    pruneLegacyRegistry(dir, false);
    expect(pruneLegacyRegistry(dir, false)).toBeNull();
  });

  test('dry-run reports but writes nothing', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'bunfig.toml'), legacyBlock);
    expect(pruneLegacyRegistry(dir, true)?.action).toBe('would-update');
    expect(readFileSync(join(dir, 'bunfig.toml'), 'utf8')).toBe(legacyBlock);
  });
});

describe('Workspace/package support', () => {
  test('resolveWorkspaces detects the array form', () => {
    const dir = monorepo();
    const pkg = detectContext(dir).pkg;
    expect(resolveWorkspaces(dir, pkg)).toEqual(['packages/api', 'packages/ui']);
  });

  test('resolveWorkspaces detects the object form (workspaces.packages)', () => {
    const dir = monorepo(true);
    const pkg = detectContext(dir).pkg;
    expect(resolveWorkspaces(dir, pkg)).toEqual(['packages/api', 'packages/ui']);
  });

  test('single package ⇒ no workspaces', () => {
    const dir = project({ name: 'x' });
    expect(resolveWorkspaces(dir, detectContext(dir).pkg)).toEqual([]);
  });

  test('isTypeScriptPackage: TS package (src/ or dep) yes, pure asset package no', () => {
    const tsDir = project({ name: 'ts', devDependencies: { typescript: '^6' } });
    expect(isTypeScriptPackage(tsDir, detectContext(tsDir).pkg)).toBe(true);
    const assetDir = project({ name: 'asset' }); // only package.json, no src/, no TS dep
    expect(isTypeScriptPackage(assetDir, detectContext(assetDir).pkg)).toBe(false);
  });

  test('init skips pure asset packages (no tsconfig)', () => {
    const dir = monorepo();
    // a pure asset package without src/ and without a TS signal:
    mkdirSync(join(dir, 'packages/assets'), { recursive: true });
    writeFileSync(join(dir, 'packages/assets/package.json'), JSON.stringify({ name: 'assets' }));
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(existsSync(join(dir, 'packages/assets/tsconfig.json'))).toBe(false);
    expect(existsSync(join(dir, 'packages/api/tsconfig.json'))).toBe(true); // TS package
  });

  test('package-scoped templates are create-only (else hash collision in a monorepo)', () => {
    for (const t of FILE_TEMPLATES) {
      if ((t.scope ?? 'root') === 'package') expect(t.policy).toBe('create-only');
    }
  });

  test('scope filter separates root from package building blocks', () => {
    const dir = project({ name: 'x' });
    const ctx = detectContext(dir);
    applyFiles(dir, ctx, { ...INIT, scope: 'root' }, emptyManifest());
    expect(existsSync(join(dir, 'cliff.toml'))).toBe(true);
    expect(existsSync(join(dir, 'tsconfig.json'))).toBe(false); // package-scoped, not at the root

    const dir2 = project({ name: 'y' });
    applyFiles(dir2, detectContext(dir2), { ...INIT, scope: 'package' }, emptyManifest());
    expect(existsSync(join(dir2, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(dir2, 'cliff.toml'))).toBe(false); // root-scoped, not here
  });

  test('init in a monorepo: tsconfig per package (Svelte per package), not at the root', () => {
    const dir = monorepo();
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(existsSync(join(dir, 'packages/api/tsconfig.json'))).toBe(true);
    expect(existsSync(join(dir, 'packages/ui/tsconfig.json'))).toBe(true);
    expect(existsSync(join(dir, 'tsconfig.json'))).toBe(false); // root untouched
    expect(existsSync(join(dir, 'cliff.toml'))).toBe(true); // root building block present
    // Svelte detected per package:
    expect(readFileSync(join(dir, 'packages/ui/tsconfig.json'), 'utf8')).toContain('svelte');
    expect(readFileSync(join(dir, 'packages/api/tsconfig.json'), 'utf8')).toContain('base.json');
  });
});

describe('formatDiff', () => {
  test('identical texts yield an empty diff', () => {
    expect(formatDiff('a\nb\n', 'a\nb\n')).toBe('');
  });

  test('empty source/target file: pure add or delete including header arithmetic', () => {
    const add = formatDiff('', 'a\nb\n', { color: false });
    expect(add).toContain('+ a');
    expect(add).toContain('@@ -1,0 +1,2 @@');
    const del = formatDiff('a\nb\n', '', { color: false });
    expect(del).toContain('- a');
    expect(del).toContain('@@ -1,2 +1,0 @@');
    expect(formatDiff('', '')).toBe(''); // both empty = no diff
  });

  test('shows a changed line with context and a hunk header', () => {
    const d = formatDiff('a\nb\nc\n', 'a\nB\nc\n', { color: false });
    expect(d).toContain('- b');
    expect(d).toContain('+ B');
    expect(d).toContain('  a'); // context line
    expect(d.split('\n').some((l) => l.startsWith('@@'))).toBe(true);
  });

  test('pure addition / pure deletion', () => {
    expect(formatDiff('a\n', 'a\nb\n', { color: false })).toContain('+ b');
    expect(formatDiff('a\nb\n', 'a\n', { color: false })).toContain('- b');
  });

  test('color:false contains no ANSI codes', () => {
    expect(formatDiff('a\n', 'b\n', { color: false })).not.toContain('[');
  });

  test('limits context: two widely separated changes ⇒ two hunks, middle invisible', () => {
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
  test('returns a diff on conflict when diff is set', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'cliff.toml'), 'FREMD\n');
    const res = applyFiles(dir, detectContext(dir), { ...SYNC, diff: true }, emptyManifest());
    const r = res.find((x) => x.dest === 'cliff.toml');
    expect(r?.action).toBe('conflict');
    expect(r?.diff).toContain('FREMD');
  });

  test('without the diff flag, no diff in the result', () => {
    const dir = project({ name: 'x' });
    writeFileSync(join(dir, 'cliff.toml'), 'FREMD\n');
    const res = applyFiles(dir, detectContext(dir), SYNC, emptyManifest());
    expect(res.find((x) => x.dest === 'cliff.toml')?.diff).toBeUndefined();
  });
});

describe('Versioning', () => {
  test('@urbicon-ui pins match the own package version (unified)', () => {
    const own = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')
    ).version;
    expect(VERSIONS['@urbicon-ui/biome-config']).toBe(`^${own}`);
    expect(VERSIONS['@urbicon-ui/commitlint-config']).toBe(`^${own}`);
    expect(VERSIONS['@urbicon-ui/tsconfig']).toBe(`^${own}`);
  });

  test('VERSIONS mirror the root catalog (single source: tool + Svelte)', () => {
    // The catalog is the ONE source; VERSIONS derives from it. If this test breaks,
    // versions.ts has decoupled from the catalog (instead of only reading it) — a bump would not propagate.
    const ws = JSON.parse(
      readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf8')
    ).workspaces;
    for (const n of TOOL_DEPS) expect(VERSIONS[n]).toBe(ws.catalog[n]);
    for (const n of SVELTE_DEPS) expect(VERSIONS[n]).toBe(ws.catalogs.svelte[n]);
  });

  test('every prescribed dep name has a catalog entry (completeness)', () => {
    const ws = JSON.parse(
      readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf8')
    ).workspaces;
    for (const n of TOOL_DEPS) expect(ws.catalog[n]).toBeDefined();
    for (const n of SVELTE_DEPS) expect(ws.catalogs.svelte[n]).toBeDefined();
  });

  test('udx packages reference catalog deps via catalog: (dogfooding, all packages & dep types)', () => {
    // udx uses its own catalog consistently: no literal pin for a dep that is in the catalog —
    // otherwise `bun outdated`/a stack update would no longer pull it along (silent pin lag).
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

  test('all workspace packages carry the same version', () => {
    const root = join(import.meta.dir, '..', '..');
    const versions = ['cli', 'biome-config', 'commitlint-config', 'tsconfig'].map(
      (p) => JSON.parse(readFileSync(join(root, p, 'package.json'), 'utf8')).version
    );
    expect(new Set(versions).size).toBe(1);
  });
});

describe('Help (--help)', () => {
  // Version-neutral (fixed placeholder) + ANSI-free ⇒ stable across bumps and TTY modes.
  const help = stripAnsi(helpText('1.2.3'));

  test('snapshot of the full help', () => {
    expect(help).toMatchSnapshot();
  });

  test('lists the dev-facing verbs as commands', () => {
    for (const cmd of ['init', 'status', 'sync', 'add <id>', 'remove <id>', 'pin', 'unpin']) {
      expect(help).toContain(cmd);
    }
  });

  test('adopt/skip/doctor appear only as aliases, not in the command table', () => {
    const commands = help.slice(help.indexOf('Commands'), help.indexOf('Options'));
    for (const legacy of ['adopt', 'skip', 'doctor']) expect(commands).not.toContain(legacy);
    // …but they do in the aliases footnote:
    expect(help).toContain('Aliases');
    for (const legacy of ['adopt', 'skip', 'doctor']) expect(help).toContain(legacy);
  });
});
