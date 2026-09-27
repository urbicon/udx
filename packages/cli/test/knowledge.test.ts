import { describe, expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runAdd, runSkip } from '../src/commands/capability.ts';
import { runDoctor } from '../src/commands/doctor.ts';
import { runHarness } from '../src/commands/harness.ts';
import { buildReport } from '../src/commands/status.ts';
import { CAPABILITIES, declinedSets, resolveCapabilities } from '../src/lib/capabilities.ts';
import { detectContext } from '../src/lib/detect.ts';
import {
  emptyManifest,
  hashContent,
  type Manifest,
  readManifest,
  writeManifest
} from '../src/lib/manifest.ts';
import { canonicalScripts } from '../src/lib/pkg.ts';
import { CLI_VERSION, VERSIONS } from '../src/lib/versions.ts';
import { FILE_TEMPLATES, KNOWLEDGE_TEMPLATE_IDS } from '../src/templates/index.ts';

const SKILL_ASSETS = join(import.meta.dir, '..', 'src', 'assets', 'skills', 'knowledge-layer');
const RENDER = detectContext(mkdtempSync(join(tmpdir(), 'udx-knowledge-render-')));

const KNOWLEDGE = FILE_TEMPLATES.filter((t) => KNOWLEDGE_TEMPLATE_IDS.includes(t.id));
const SKILL = KNOWLEDGE.filter((t) => t.policy === 'managed');
const SCAFFOLDS = KNOWLEDGE.filter((t) => t.policy === 'create-only');
const SKILL_MD = SKILL.find((t) => basename(t.dest) === 'SKILL.md');
const INTERNAL_README = 'docs/internal/README.md';

const HARNESS_DEFAULTS = {
  force: false,
  svelte: undefined,
  diff: false,
  only: [] as string[],
  interactive: false,
  install: false
};

function project(pkg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'udx-knowledge-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

const readPkg = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), 'utf8');

/** git with a throwaway identity and no hooks, so the user's global config cannot interfere. */
function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=udx',
      '-c',
      'user.email=udx@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe' }
  );
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString()}`);
}

function write(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

const knowledgeState = (dir: string, manifest: Manifest = readManifest(dir)) =>
  resolveCapabilities(detectContext(dir), manifest).find((s) => s.cap.id === 'knowledge');

const add = (dir: string, dryRun = false): number =>
  runAdd({ ...HARNESS_DEFAULTS, cwd: dir, dryRun, capability: 'knowledge' });

const sync = (dir: string, extra: Partial<typeof HARNESS_DEFAULTS> = {}): number =>
  runHarness('sync', { ...HARNESS_DEFAULTS, ...extra, cwd: dir, dryRun: false });

/** Runs `fn` with console output captured (colors are off outside a TTY). */
function captured(fn: () => number): { code: number; out: string } {
  const lines: string[] = [];
  const push = (...args: unknown[]): void => {
    lines.push(args.join(' '));
  };
  const out = spyOn(console, 'log').mockImplementation(push);
  const err = spyOn(console, 'error').mockImplementation(push);
  try {
    return { code: fn(), out: lines.join('\n') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe('knowledge templates', () => {
  test('one managed template per skill asset file — the list covers the directory exactly', () => {
    expect(SKILL.map((t) => basename(t.dest)).sort()).toEqual(readdirSync(SKILL_ASSETS).sort());
    for (const t of SKILL)
      expect(t.dest).toBe(`.claude/skills/knowledge-layer/${basename(t.dest)}`);
  });

  test('the docs scaffolds are create-only', () => {
    expect(SCAFFOLDS.map((t) => t.dest).sort()).toEqual([
      'docs/DECISIONS.md',
      'docs/README.md',
      'docs/internal/README.md'
    ]);
  });

  test('docs:check is a root-tier script, the CLI a root-tier devDep at its own version', () => {
    const ctx = detectContext(project({ name: 'x', devDependencies: { svelte: '^5' } }));
    expect(canonicalScripts(ctx, 'root')['docs:check']).toBe('udx docs check');
    expect(canonicalScripts(ctx, 'svelte')['docs:check']).toBeUndefined();
    expect(VERSIONS['@urbicon-ui/udx']).toBe(`^${CLI_VERSION}`);
  });
});

describe('opt-in resolution', () => {
  test('inactive by default: available, neither declined nor fresh', () => {
    expect(knowledgeState(project({ name: 'x' }), emptyManifest())).toMatchObject({
      declined: false,
      available: true,
      fresh: false,
      reason: ''
    });
  });

  test('inactive means skipped: files, script and devDep land in the skip sets', () => {
    const sets = declinedSets(
      resolveCapabilities(detectContext(project({ name: 'x' })), emptyManifest())
    );
    for (const id of KNOWLEDGE_TEMPLATE_IDS) {
      expect(sets.files.get(id)).toBe('opt-in, not added — `udx add knowledge`');
      expect(sets.unlisted.has(id)).toBe(true);
    }
    expect(sets.scripts.has('docs:check')).toBe(true);
    expect(sets.devDeps.has('@urbicon-ui/udx')).toBe(true);
  });

  test('only opt-in files are unlisted — a declined regular capability keeps its per-file line', () => {
    const ctx = detectContext(project({ name: 'x', devDependencies: { husky: '^9' } }));
    const sets = declinedSets(resolveCapabilities(ctx, emptyManifest()));
    expect(sets.files.get('lefthook')).toBe('declined (husky)');
    expect(sets.unlisted.has('lefthook')).toBe(false);
  });

  test('active once adopted', () => {
    const m: Manifest = { ...emptyManifest(), adopted: ['knowledge'] };
    expect(knowledgeState(project({ name: 'x' }), m)).toMatchObject({
      declined: false,
      available: false
    });
  });

  test('init/sync never persist the opt-in as declined', () => {
    const dir = project({ name: 'x' });
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    sync(dir);
    const m = readManifest(dir);
    expect(m.declined.knowledge).toBeUndefined();
    expect(m.adopted).not.toContain('knowledge');
  });

  test('every regular capability stays active by default (opt-in is the exception)', () => {
    const states = resolveCapabilities(detectContext(project({ name: 'x' })), emptyManifest());
    for (const s of states) expect(s.available).toBe(Boolean(s.cap.optIn));
    expect(CAPABILITIES.filter((c) => c.optIn).map((c) => c.id)).toEqual(['knowledge']);
  });
});

describe('knowledge: init/sync without add', () => {
  test('write none of its files, scripts or devDeps', () => {
    const dir = project({ name: 'x' });
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    sync(dir);
    expect(existsSync(join(dir, 'cliff.toml'))).toBe(true); // the rest of the harness is there
    for (const t of KNOWLEDGE) expect(existsSync(join(dir, t.dest))).toBe(false);
    const pkg = readPkg(dir);
    expect(pkg.scripts['docs:check']).toBeUndefined();
    expect(pkg.devDependencies['@urbicon-ui/udx']).toBeUndefined();
    expect(Object.keys(readManifest(dir).files).some((f) => f.startsWith('.claude/'))).toBe(false);
  });

  test('sync names the capability once, not its files', () => {
    const { out } = captured(() => sync(project({ name: 'x' })));
    expect(out.match(/Knowledge layer \(docs:check\): available \(opt-in\)/g)).toHaveLength(1);
    expect(out).not.toContain('.claude/skills');
    expect(out).toContain('udx add knowledge');
  });

  test('sync --only knowledge says it is not added — nothing was declined', () => {
    const dir = project({ name: 'x' });
    const { out } = captured(() => sync(dir, { only: ['knowledge'] }));
    expect(out).toContain('opt-in, not added — `udx add knowledge`');
    expect(out).not.toContain('declined');
    for (const t of KNOWLEDGE) expect(existsSync(join(dir, t.dest))).toBe(false);
  });
});

describe('knowledge: the working-docs store', () => {
  test('public adopter: a fresh clone of a repo whose store is git-ignored stays clean', () => {
    const origin = project({ name: 'pub' });
    git(origin, 'init', '-q');
    write(origin, '.gitignore', 'node_modules/\ndocs/internal/\n');
    mkdirSync(join(origin, 'docs/internal'), { recursive: true });
    git(join(origin, 'docs/internal'), 'init', '-q'); // the store: a repository of its own
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: origin, dryRun: false });
    add(origin);
    expect(existsSync(join(origin, INTERNAL_README))).toBe(false);
    git(origin, 'add', '-A');
    git(origin, 'commit', '-qm', 'harness');

    const clone = join(mkdtempSync(join(tmpdir(), 'udx-clone-')), 'pub');
    git(tmpdir(), 'clone', '-q', origin, clone);
    expect(existsSync(join(clone, '.claude/skills/knowledge-layer/SKILL.md'))).toBe(true);
    expect(existsSync(join(clone, 'docs/internal'))).toBe(false); // the store stayed behind

    const doctor = captured(() => runDoctor({ cwd: clone, svelte: undefined, diff: false }));
    expect(doctor.code).toBe(0);
    expect(doctor.out).not.toContain('docs/internal');
    const rows = buildReport({ cwd: clone, svelte: undefined, json: false }).sections.flatMap(
      (s) => s.rows
    );
    expect(rows.filter((r) => r.state === 'missing')).toEqual([]);
    sync(clone);
    expect(existsSync(join(clone, 'docs/internal'))).toBe(false);
  });

  test('private adopter: a tracked store gets the README', () => {
    const dir = project({ name: 'priv' });
    git(dir, 'init', '-q');
    add(dir);
    const tpl = SCAFFOLDS.find((t) => t.dest === INTERNAL_README);
    expect(read(dir, INTERNAL_README)).toBe(tpl?.render(RENDER) as string);
  });

  test('udx.docs.workingDocs elsewhere ⇒ no docs/internal README; the default, however spelled, gets one', () => {
    const elsewhere = project({ name: 'x', udx: { docs: { workingDocs: 'docs/planning' } } });
    add(elsewhere);
    expect(existsSync(join(elsewhere, 'docs/internal'))).toBe(false);
    expect(existsSync(join(elsewhere, 'docs/DECISIONS.md'))).toBe(true);

    const spelled = project({ name: 'y', udx: { docs: { workingDocs: './docs/internal/' } } });
    add(spelled);
    expect(existsSync(join(spelled, INTERNAL_README))).toBe(true);
  });
});

describe('udx add knowledge', () => {
  test('writes the skill, the three scaffolds, the script and the devDep — nothing else', () => {
    const dir = project({ name: 'x' });
    expect(add(dir)).toBe(0);
    for (const t of KNOWLEDGE) expect(read(dir, t.dest)).toBe(t.render(RENDER));
    const pkg = readPkg(dir);
    expect(pkg.scripts['docs:check']).toBe('udx docs check');
    expect(pkg.devDependencies['@urbicon-ui/udx']).toBe(`^${CLI_VERSION}`);
    expect(existsSync(join(dir, 'cliff.toml'))).toBe(false); // surgical
    expect(pkg.scripts.bump).toBeUndefined();

    const m = readManifest(dir);
    expect(m.adopted).toContain('knowledge');
    for (const t of SKILL) expect(m.files[t.dest]).toBe(hashContent(t.render(RENDER)));
    for (const t of SCAFFOLDS) expect(m.files[t.dest]).toBeUndefined(); // create-only: no hash
  });

  test('dry-run writes nothing', () => {
    const dir = project({ name: 'x' });
    expect(add(dir, true)).toBe(0);
    for (const t of KNOWLEDGE) expect(existsSync(join(dir, t.dest))).toBe(false);
    expect(existsSync(join(dir, '.udx.json'))).toBe(false);
    expect(readPkg(dir).scripts).toBeUndefined();
  });

  test('an existing docs/README.md stays untouched, the missing scaffolds are created', () => {
    const dir = project({ name: 'x' });
    write(dir, 'docs/README.md', '# Our docs\n');
    add(dir);
    expect(read(dir, 'docs/README.md')).toBe('# Our docs\n');
    expect(existsSync(join(dir, 'docs/DECISIONS.md'))).toBe(true);
    expect(existsSync(join(dir, 'docs/internal/README.md'))).toBe(true);
  });

  test('a later sync updates a skill file whose asset changed', () => {
    const dir = project({ name: 'x' });
    add(dir);
    const dest = SKILL_MD?.dest as string;
    // As if an older udx had written the previous asset version and remembered its hash.
    write(dir, dest, 'previous asset\n');
    const m = readManifest(dir);
    m.files[dest] = hashContent('previous asset\n');
    writeManifest(dir, m, false);

    sync(dir);
    expect(read(dir, dest)).toBe(SKILL_MD?.render(RENDER) as string);
    expect(readManifest(dir).files[dest]).toBe(hashContent(read(dir, dest)));
  });

  test('a locally modified skill file is protected as a conflict', () => {
    const dir = project({ name: 'x' });
    add(dir);
    const dest = SKILL_MD?.dest as string;
    const edited = `${read(dir, dest)}\nLocal addition.\n`;
    write(dir, dest, edited);

    const { out } = captured(() => sync(dir));
    expect(read(dir, dest)).toBe(edited);
    expect(out).toContain(`conflict`);
    const row = buildReport({ cwd: dir, svelte: undefined, json: false })
      .sections.find((s) => s.title === 'Files')
      ?.rows.find((r) => r.label === dest);
    expect(row?.state).toBe('customized');

    sync(dir, { force: true });
    expect(read(dir, dest)).toBe(SKILL_MD?.render(RENDER) as string);
  });

  test('keeps the CLI devDep at the CLI version and drops the old-scope name', () => {
    const dir = project({
      name: 'x',
      devDependencies: { '@urbicon-ui/udx': '^0.0.1', '@urbicon/udx': '^0.2.9' }
    });
    add(dir);
    const deps = readPkg(dir).devDependencies;
    expect(deps['@urbicon-ui/udx']).toBe(`^${CLI_VERSION}`);
    expect(deps['@urbicon/udx']).toBeUndefined();
  });

  test('remove works as for any capability: a manual decline, files stay, sync leaves them', () => {
    const dir = project({ name: 'x' });
    add(dir);
    expect(runSkip({ cwd: dir, dryRun: false, capability: 'knowledge' })).toBe(0);
    const m = readManifest(dir);
    expect(m.declined.knowledge).toBe('manual');
    expect(m.adopted).not.toContain('knowledge');
    expect(knowledgeState(dir)).toMatchObject({ declined: true, available: false });

    const dest = SKILL_MD?.dest as string;
    rmSync(join(dir, dest));
    sync(dir);
    expect(existsSync(join(dir, dest))).toBe(false);
    expect(existsSync(join(dir, 'docs/DECISIONS.md'))).toBe(true);
  });
});

describe('knowledge: supersededBy', () => {
  test('an own docs:refs:check script supersedes it — reported, never persisted', () => {
    const dir = project({ name: 'x', scripts: { 'docs:refs:check': 'bun run scripts/refs.ts' } });
    expect(knowledgeState(dir, emptyManifest())).toMatchObject({
      declined: true,
      available: false,
      fresh: false,
      reason: 'docs:refs:check script'
    });
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    expect(readManifest(dir).declined.knowledge).toBeUndefined();
  });

  test('an own docs:check supersedes it, udx’s own docs:check does not', () => {
    const own = project({ name: 'x', scripts: { 'docs:check': 'node check-links.js' } });
    expect(knowledgeState(own, emptyManifest())?.reason).toBe('docs:check script');
    const ours = project({ name: 'y', scripts: { 'docs:check': 'udx docs check' } });
    expect(knowledgeState(ours, emptyManifest())).toMatchObject({
      declined: false,
      available: true
    });
  });

  test('add adopts it anyway and keeps the own script', () => {
    const dir = project({ name: 'x', scripts: { 'docs:check': 'node check-links.js' } });
    add(dir);
    expect(knowledgeState(dir)).toMatchObject({ declined: false, available: false });
    expect(readPkg(dir).scripts['docs:check']).toBe('node check-links.js');
    expect(existsSync(join(dir, SKILL_MD?.dest as string))).toBe(true);
  });
});

describe('knowledge in status/doctor', () => {
  const sectionOf = (dir: string, title: string) =>
    buildReport({ cwd: dir, svelte: undefined, json: false }).sections.find(
      (s) => s.title === title
    )?.rows ?? [];

  test('status lists it as available with the command that enables it', () => {
    const dir = project({ name: 'x' });
    const row = sectionOf(dir, 'Building blocks').find((r) =>
      r.label.startsWith('Knowledge layer')
    );
    expect(row).toMatchObject({ state: 'available', cmd: 'udx add knowledge' });
    expect(sectionOf(dir, 'Files').some((r) => r.label.startsWith('.claude/'))).toBe(false);
    expect(sectionOf(dir, 'package.json').some((r) => r.label.includes('docs:check'))).toBe(false);
  });

  test('doctor reports it as available, not as an error or a stale decline', () => {
    const dir = project({ name: 'x' });
    runHarness('init', { ...HARNESS_DEFAULTS, cwd: dir, dryRun: false });
    const { code, out } = captured(() => runDoctor({ cwd: dir, svelte: undefined, diff: false }));
    expect(code).toBe(0);
    expect(out).toContain('Knowledge layer (docs:check): available (opt-in) — `udx add knowledge`');
    expect(out).not.toContain('.claude/skills');
    expect(out).not.toContain('docs:check script');
    expect(out).not.toContain('no longer detected');
  });

  test('once added, status shows it active and doctor checks its files', () => {
    const dir = project({ name: 'x' });
    add(dir);
    const row = sectionOf(dir, 'Building blocks').find((r) =>
      r.label.startsWith('Knowledge layer')
    );
    expect(row).toMatchObject({ state: 'sync', detail: 'active' });
    const { out } = captured(() => runDoctor({ cwd: dir, svelte: undefined, diff: false }));
    expect(out).toContain(SKILL_MD?.dest as string);
    expect(out).not.toContain(`missing: ${SKILL_MD?.dest}`);
    expect(out).not.toContain('available (opt-in)');
  });
});
