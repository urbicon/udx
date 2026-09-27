import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Positive controls for `udx docs check`, against its own oracles.
 *
 * Its failure mode is silence: an extraction that reads nothing, a fence tracker that swallows a
 * document, a resolver that accepts everything all print "0 findings" exactly like a clean tree. So
 * every block runs the real CLI over a fixture repo and asserts both directions — the clean tree
 * passes with a non-zero reference count, and one planted violation per concern comes back with its
 * kind at its line. The fixture is a repo, not a mock: `--root` is all the check is told. Most
 * fixtures are deliberately no git checkout, the state in which `git check-ignore` answers nothing
 * and every path must resolve on its own; `track()` turns one into a checkout where a rule asks git.
 *
 * The sabotage each control of a layer rule catches (rules 1–5 and the allowlist are the ported
 * controls, each named by its test):
 *   - budget     — comparing against the wrong number, or never comparing: the over-budget fixture
 *                  passes.
 *   - delivery   — accepting any CLAUDE.md, or reading the import case-insensitively: a plain
 *                  CLAUDE.md, a fenced `@AGENTS.md`, a symlink elsewhere or `@AGENTS.md` for
 *                  `Agents.md` pass. Matching whole lines only fails the prose import; reading
 *                  code spans or not ending the name passes `see @AGENTS.md` / `@AGENTS.md.bak`.
 *   - lifecycle  — reading the whole file or a longer head, or a marker list that matches
 *                  everything: a marker on line 21 or none at all passes. Ignoring folder READMEs
 *                  reports the harness task files; letting any README cover its folder hides a
 *                  README without an end condition; a case-exact README misses `readme.md`; an
 *                  unread negation passes "not permanent".
 *   - archive    — walking only the disk or only the index: one of the two archives goes unseen.
 *   - checkbox   — reading reference docs, fenced blocks, `[x]` or the tracker, or ignoring the
 *                  file exemption: the clean cases turn into findings; dropping the working docs
 *                  or the index loses a planted open item.
 *   - store      — `.git` sighted instead of git asked, the ignore check skipped, or asked of the
 *                  folder instead of a file inside it: an ignored-without-history folder passes
 *                  (`dir/*` and `dir/**` ignore the contents, not the folder).
 *   - config     — accepting a malformed key: the run exits 0 or 1 instead of 2.
 *   - self-test  — an asset of `udx add knowledge` that trips any rule: the managed skill would
 *                  fail its own gate in every project that installs it.
 *
 * No test here spells a path below the working-docs folder literally (`WD` builds them): this file
 * is tracked, and the check reads every tracked file for exactly such pointers.
 */

const UDX = join(import.meta.dir, '../src/bin/udx.ts');
const WD = 'docs/internal';

/**
 * Without the caller's `GIT_*` (a hook running the suite would make every fixture a view of the
 * outer repo) and without global/system git config (a personal excludes file would ignore fixture
 * paths).
 */
const ENV: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => !e[0].startsWith('GIT_') && e[1] !== undefined
    )
  ),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  NO_COLOR: '1'
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(root: string, path: string, body: string): void {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

/** Appends a line and returns the 1-based line number it landed on. */
function appendLine(root: string, path: string, text: string): number {
  const file = join(root, path);
  const before = readFileSync(file, 'utf-8');
  writeFileSync(file, `${before}${text}\n`);
  return before.split('\n').length;
}

const ALLOWED = 'NOT_A_CONST';

/** Merges `docs` into the fixture's `udx.docs`. */
function configure(root: string, docs: Record<string, unknown>): void {
  const file = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf-8'));
  pkg.udx = { docs: { ...pkg.udx?.docs, ...docs } };
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** A repo the check passes on: every reference in it resolves. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'udx-docs-'));
  dirs.push(root);

  write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: 'fixture',
        private: true,
        workspaces: ['packages/*'],
        repository: { type: 'git', url: 'git+https://github.com/acme/fixture.git' },
        scripts: { lint: 'echo lint', 'docs:gen': 'echo gen' },
        udx: {
          docs: {
            allowlist: [[ALLOWED, 'a verdict word the probe skill writes, not a constant']]
          }
        }
      },
      null,
      2
    )}\n`
  );
  write(
    root,
    'packages/table/package.json',
    `${JSON.stringify({ name: '@acme/table', scripts: { test: 'echo test' } }, null, 2)}\n`
  );
  write(root, 'packages/table/src/lib/thing.ts', 'export const LIVE_CONST = 1;\n');
  write(root, 'scripts/keeper.ts', 'export const KEEPER = LIVE_CONST;\n');
  // Named `scripts/only-here.ts` in a doc, this resolves by tail and is still wrong: `scripts/` is a
  // real top-level directory, so the spelling is a claim about the root.
  write(root, 'packages/table/scripts/only-here.ts', 'export const ONLY = 1;\n');

  write(
    root,
    '.claude/skills/probe/SKILL.md',
    `# Probe skill\n\nReads \`packages/table/src/lib/thing.ts\`.\n\nVerdicts: \`${ALLOWED}\`.\n`
  );

  write(
    root,
    'AGENTS.md',
    [
      '# Fixture',
      '',
      '## Commands',
      '',
      '- `bun run lint` runs the whole tree, `bun run docs:gen` the catalogs.',
      "- `bun --filter='@acme/table' run test` and `bun --filter='./packages/table' run test`.",
      '',
      '## Paths',
      '',
      'Sources: `packages/table/src/lib/thing.ts`, `scripts/keeper.ts`, `lib/thing.ts`,',
      'and the pointer `keeper.ts:1` plus `packages/table/src/lib/thing.ts:1-1`.',
      '',
      'A file is not a script name: `bun run scripts/keeper.ts`.',
      '',
      'Exemptions: `LIVE_CONST`.',
      '',
      'Neither a template path `packages/<Name>/src/index.ts` nor a URL',
      '`https://example.com/missing.md` is a claim that a file exists, and',
      '[nor is a link to one](https://example.com/missing.md).',
      '',
      'See [the index](docs/README.md) and [a section](docs/README.md#the-fixture-index).',
      '',
      '```sh',
      '# a fenced block is not a reference: `bun run nothing-at-all`',
      '```',
      ''
    ].join('\n')
  );
  symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));

  write(
    root,
    'docs/README.md',
    [
      '# The fixture index',
      '',
      '- [AGENTS](../AGENTS.md)',
      '- [guide](./GUIDE.md#a-heading-with-punctuation)',
      '- [the second repeat](./GUIDE.md#repeat-1)',
      '- [inline code in the heading](./GUIDE.md#the-thing-contract)',
      '- [`docs/GONE.md`](./GUIDE.md) — a label names, it does not claim',
      ''
    ].join('\n')
  );
  // A tarball doc: docs/ carries a symlink, the file lives in its package.
  write(root, 'packages/table/docs/TARBALL.md', '# Tarball doc\n\nShips `lib/thing.ts`.\n');
  symlinkSync('../packages/table/docs/TARBALL.md', join(root, 'docs/TARBALL.md'));

  write(
    root,
    'docs/GUIDE.md',
    [
      '# Fixture guide',
      '',
      '## A heading, with punctuation!',
      '',
      'Generated by `bun run docs:gen`.',
      '',
      '## Repeat',
      '',
      '## Repeat',
      '',
      '## The `<Thing>` contract',
      '',
      '```md',
      '## Fenced heading',
      '```',
      ''
    ].join('\n')
  );
  return root;
}

function runArgs(...args: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync([process.execPath, UDX, 'docs', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: ENV
  });
  return { code: proc.exitCode, out: `${proc.stdout.toString()}${proc.stderr.toString()}` };
}

const run = (root: string) => runArgs('check', '--root', root);

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: ENV });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString()}`);
}

/** Makes the working docs private the way a public repo does: git ignores what goes into them. */
function ignoreWorkingDocs(root: string, pattern = `${WD}/`): void {
  write(root, '.gitignore', `${pattern}\n`);
}

/** Turns a fixture into a checkout whose index holds every file in it — the private rule's oracle. */
function track(root: string): void {
  git(root, 'init', '-q');
  git(root, 'add', '-A');
}

describe('udx docs check — references (rules 1–4)', () => {
  it('passes a fixture repo whose references all resolve, having read some', () => {
    const { code, out } = run(fixture());
    expect(out).toContain('0 findings');
    expect(code).toBe(0);
    // The blindness guard: 0 findings only counts if something was examined.
    expect(Number(out.match(/(\d+) references/)?.[1])).toBeGreaterThan(15);
    // CLAUDE.md and docs/TARBALL.md are symlinks to sources already read.
    expect(out).toMatch(/5 sources/);
    // A root spelled differently from its realpath (macOS /var → /private/var) once made every
    // source unrecognisable, the index included.
    expect(Number(out.match(/AGENTS\.md: (\d+) words/)?.[1])).toBeGreaterThan(0);
  });

  it('reports neither a `<Name>` template path, a URL, nor a fenced block', () => {
    const { out } = run(fixture());
    expect(out).not.toContain('Name');
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('nothing-at-all');
    // A path inside a link label: the target is the claim, the label a name.
    expect(out).not.toContain('GONE');
  });

  it('reads a symlinked tarball doc, and reports it at its target path', () => {
    const root = fixture();
    const line = appendLine(
      root,
      'packages/table/docs/TARBALL.md',
      'Run `bun run gone-from-here`.'
    );
    const { out } = run(root);
    expect(out).toContain(`packages/table/docs/TARBALL.md:${line}  script  gone-from-here`);
    // Once: the symlink and its target are the same document.
    expect(out.match(/gone-from-here/g)).toHaveLength(1);
    expect(out).not.toMatch(/(?:^|\s)docs\/TARBALL\.md:/m);
  });

  it('reports a root script that no longer exists', () => {
    const root = fixture();
    const line = appendLine(root, 'AGENTS.md', 'Run `bun run no-such-script` first.');
    const { code, out } = run(root);
    expect(out).toContain(`AGENTS.md:${line}  script  no-such-script`);
    expect(code).toBe(1);
  });

  it('hands `bun run <file>` to the path rule, not the script rule', () => {
    const root = fixture();
    const line = appendLine(root, 'AGENTS.md', 'Run `bun run scripts/gone.ts`.');
    const { out } = run(root);
    expect(out).toContain(`AGENTS.md:${line}  path  scripts/gone.ts`);
    // Never as a script called `scripts`: the capture used to stop at the `/`.
    expect(out).not.toMatch(/script {2}scripts {2}/);
  });

  it('reports a package script that no longer exists', () => {
    const root = fixture();
    const line = appendLine(root, 'AGENTS.md', "Run `bun --filter='@acme/table' run gone`.");
    const { out } = run(root);
    expect(out).toContain(`AGENTS.md:${line}  script  gone`);
    expect(out).toContain('not a script of packages/table/package.json');
  });

  it('asks --filter the way Bun does: an exact name or a ./path, never a short name', () => {
    const root = fixture();
    // `bun --filter=table` matches no package called `@acme/table`; Bun says so itself.
    const short = appendLine(root, 'AGENTS.md', "Run `bun --filter='table' run test`.");
    const bare = appendLine(root, 'AGENTS.md', 'Run `bun --filter=packages/table run test`.');
    const { out } = run(root);
    expect(out).toContain(`AGENTS.md:${short}  script  --filter=table`);
    expect(out).toContain(`AGENTS.md:${bare}  script  --filter=packages/table`);
  });

  it("reads Bun's flags as flags: --filter, -F and --cwd pick the package, --bun is none", () => {
    const root = fixture();
    for (const span of [
      "bun run --filter '@acme/table' test",
      'bun run --filter=@acme/table test',
      'bun run -F @acme/table test',
      'bun run -F@acme/table test',
      'bun run --bun lint',
      'bun --bun run lint',
      'bun run --cwd packages/table test',
      'bun run --workspaces anything-at-all'
    ])
      appendLine(root, 'AGENTS.md', `Run \`${span}\`.`);
    const filtered = appendLine(root, 'AGENTS.md', "Run `bun run --filter '@acme/table' lint`.");
    const bunned = appendLine(root, 'AGENTS.md', 'Run `bun run --bun gone`.');
    const cwd = appendLine(root, 'AGENTS.md', 'Run `bun run --cwd packages/table lint`.');
    const { out } = run(root);
    // A flag is never a script name.
    expect(out).not.toMatch(/script {2}-/);
    expect(out).not.toContain('anything-at-all');
    expect(out).toContain(`AGENTS.md:${filtered}  script  lint  →  not a script of packages/table`);
    expect(out).toContain(`AGENTS.md:${bunned}  script  gone`);
    expect(out).toContain(`AGENTS.md:${cwd}  script  lint  →  not a script of packages/table`);
    expect(out.match(/ {2}script {2}/g)).toHaveLength(3);
  });

  it('knows the anchors GitHub renders: HTML ids, setext headings, encoded fragments', () => {
    const root = fixture();
    write(
      root,
      'docs/ANCHORS.md',
      [
        '---',
        'title: Front matter',
        '---',
        '',
        '<a id="Custom-Anchor"></a>',
        '<h3 name="named">Named</h3>',
        '',
        'Setext Title',
        '============',
        '',
        'Second level',
        '------------',
        '',
        '## Über uns',
        ''
      ].join('\n')
    );
    for (const frag of ['custom-anchor', 'named', 'setext-title', 'second-level', '%C3%BCber-uns'])
      appendLine(root, 'docs/README.md', `- [x](./ANCHORS.md#${frag})`);
    const front = appendLine(root, 'docs/README.md', '- [x](./ANCHORS.md#title-front-matter)');
    const { out } = run(root);
    // The front matter's closing `---` is no setext underline.
    expect(out).toContain(`docs/README.md:${front}  link  ./ANCHORS.md#title-front-matter`);
    expect(out.match(/ {2}link {2}/g)).toHaveLength(1);
  });

  it('checks every link form: titles, <…> targets, reference definitions', () => {
    const root = fixture();
    const single = appendLine(root, 'docs/README.md', "- [a](./GONE-A.md 'a title')");
    const paren = appendLine(root, 'docs/README.md', '- [b](./GONE-B.md (a title))');
    const angle = appendLine(root, 'docs/README.md', '- [c](<./GONE C.md>)');
    const encoded = appendLine(root, 'docs/README.md', '- [d](./GONE%20D.md)');
    const def = appendLine(root, 'docs/README.md', '[gone-ref]: ./GONE-REF.md "title"');
    appendLine(root, 'docs/README.md', '[good-ref]: ./GUIDE.md#repeat-1');
    appendLine(root, 'docs/README.md', '[^1]: a footnote is no link, see (./NOT-A-LINK.md)');
    write(root, 'docs/HAS SPACE.md', '# Spaced\n');
    appendLine(root, 'docs/README.md', '- [e](<./HAS SPACE.md>) and [f](./HAS%20SPACE.md#spaced)');
    const { out } = run(root);
    expect(out).toContain(`docs/README.md:${single}  link  ./GONE-A.md`);
    expect(out).toContain(`docs/README.md:${paren}  link  ./GONE-B.md`);
    expect(out).toContain(`docs/README.md:${angle}  link  ./GONE C.md`);
    expect(out).toContain(`docs/README.md:${encoded}  link  ./GONE%20D.md`);
    expect(out).toContain(`docs/README.md:${def}  link  ./GONE-REF.md`);
    expect(out).not.toContain('NOT-A-LINK');
    expect(out).not.toContain('SPACE');
  });

  it('closes a fence only on its own character, at least as long', () => {
    const root = fixture();
    appendLine(
      root,
      'docs/GUIDE.md',
      [
        '````md',
        '```sh',
        '`bun run inside-a-fence`',
        '```',
        '~~~',
        '`bun run still-inside`',
        '````'
      ].join('\n')
    );
    const after = appendLine(root, 'docs/GUIDE.md', 'Then `bun run after-the-fence`.');
    const { out } = run(root);
    expect(out).not.toContain('inside');
    expect(out).toContain(`docs/GUIDE.md:${after}  script  after-the-fence`);
  });

  it('finds an identifier in any tracked file but the docs being checked', () => {
    const root = fixture();
    write(root, '.env.example', 'XFF_DEPTH=1\n');
    write(root, 'cli/tool.ts', 'const token = process.env.TOOL_TOKEN;\n');
    write(root, '.buny/hooks/post-install.sh', 'export PLAYWRIGHT_BROWSERS_PATH=0\n');
    write(root, 'CHANGELOG.md', '# Changelog\n\n- renamed `OLD_NAME`\n');
    appendLine(root, 'docs/GUIDE.md', 'Also `ONLY_IN_DOCS`.');
    appendLine(root, 'AGENTS.md', 'Set `XFF_DEPTH`, `TOOL_TOKEN` and `PLAYWRIGHT_BROWSERS_PATH`.');
    const self = appendLine(root, 'AGENTS.md', 'Not `ONLY_IN_DOCS`, nor `OLD_NAME`.');
    track(root);
    const { out } = run(root);
    expect(out).not.toContain('XFF_DEPTH');
    expect(out).not.toContain('TOOL_TOKEN');
    expect(out).not.toContain('PLAYWRIGHT_BROWSERS_PATH');
    // The docs are what is checked, never the proof; the changelog is history.
    expect(out).toContain(`AGENTS.md:${self}  ident  ONLY_IN_DOCS`);
    expect(out).toContain(`AGENTS.md:${self}  ident  OLD_NAME`);
    expect(out).toContain('occurs in no tracked file outside the docs being checked');
  });

  it('greps only the configured codeRoots, and only their tracked files', () => {
    const root = fixture();
    configure(root, { codeRoots: ['scripts', 'packages/*/src'] });
    write(root, '.env.example', 'XFF_DEPTH=1\n');
    const line = appendLine(root, 'AGENTS.md', 'Set `XFF_DEPTH` and `LIVE_CONST`.');
    track(root);
    write(root, 'scripts/untracked.ts', 'export const LOCAL_ONLY = 1;\n');
    const local = appendLine(root, 'AGENTS.md', 'Not `LOCAL_ONLY`.');
    const { out } = run(root);
    expect(out).toContain(
      `AGENTS.md:${line}  ident  XFF_DEPTH  →  occurs in no file under codeRoots`
    );
    expect(out).not.toContain('LIVE_CONST');
    expect(out).toContain(`AGENTS.md:${local}  ident  LOCAL_ONLY`);
  });

  it('reports a path that no longer exists, root-anchored or by tail', () => {
    const root = fixture();
    const line = appendLine(root, 'docs/GUIDE.md', 'See `packages/table/src/lib/gone.ts`.');
    const tail = appendLine(root, 'docs/GUIDE.md', 'Or `lib/gone.ts`.');
    const { out } = run(root);
    expect(out).toContain(`docs/GUIDE.md:${line}  path  packages/table/src/lib/gone.ts`);
    expect(out).toContain(`docs/GUIDE.md:${tail}  path  lib/gone.ts`);
  });

  it('reports a root-anchored path although the tail resolves', () => {
    const root = fixture();
    // `packages/table/scripts/only-here.ts` is on disk, so the tail is there. `scripts/` is a real
    // top-level directory, so this spelling is wrong.
    const line = appendLine(root, 'docs/GUIDE.md', 'See `scripts/only-here.ts`.');
    const { out } = run(root);
    expect(out).toContain(`docs/GUIDE.md:${line}  path  scripts/only-here.ts`);
    expect(out).toContain('no such file at the repo root');
  });

  it('asks existence case-exactly, as the Linux CI will', () => {
    const root = fixture();
    const path = appendLine(root, 'AGENTS.md', 'See `docs/guide.md`.');
    const link = appendLine(root, 'AGENTS.md', 'And [the guide](docs/Guide.md).');
    const { out } = run(root);
    expect(out).toContain(`AGENTS.md:${path}  path  docs/guide.md`);
    expect(out).toContain(`AGENTS.md:${link}  link  docs/Guide.md`);
  });

  it('never resolves a tail inside a nested repository', () => {
    const root = fixture();
    write(root, '.claude/worktrees/wt/lib/only-there.ts', 'export {};\n');
    write(root, '.claude/worktrees/wt/.git', 'gitdir: /nowhere\n');
    const line = appendLine(root, 'AGENTS.md', 'See `lib/only-there.ts`.');
    const { out } = run(root);
    expect(out).toContain(`AGENTS.md:${line}  path  lib/only-there.ts`);
  });

  it('resolves a `#alias/…` path through package.json `imports`, as Node does', () => {
    const root = fixture();
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    pkg.imports = { '#lib/*': { bun: './packages/table/src/lib/*', default: './dist/lib/*' } };
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    appendLine(root, 'AGENTS.md', 'Via `#lib/thing.ts` and `#lib/thing.ts:1`.');
    const gone = appendLine(root, 'AGENTS.md', 'Not `#lib/gone.ts`.');
    const unmapped = appendLine(root, 'AGENTS.md', 'Nor `#core/run.ts`.');
    const { out } = run(root);
    expect(out).not.toContain('thing.ts');
    expect(out).toContain(`AGENTS.md:${gone}  path  #lib/gone.ts  →  no file where package.json`);
    expect(out).toContain(`AGENTS.md:${unmapped}  path  #core/run.ts  →  no package.json`);
  });

  it('lets a package doc name its own package scripts, and neither a script of another', () => {
    const root = fixture();
    appendLine(root, 'packages/table/docs/TARBALL.md', 'Run `bun run test` here.');
    const line = appendLine(root, 'docs/GUIDE.md', 'Run `bun run test` at the root.');
    const { out } = run(root);
    expect(out).not.toContain('TARBALL.md');
    expect(out).toContain(`docs/GUIDE.md:${line}  script  test`);
  });

  it('reads a scheme-less URL in a span as a site, but a link spelled so as a link', () => {
    const root = fixture();
    appendLine(root, 'AGENTS.md', 'Asks `wikidata.org/w/api.php` and `github.com/acme/x`.');
    const link = appendLine(root, 'AGENTS.md', 'A [relative link](example.org/page.md).');
    const { out } = run(root);
    expect(out).not.toContain('wikidata');
    expect(out).not.toContain('github.com/acme/x');
    expect(out).toContain(`AGENTS.md:${link}  link  example.org/page.md`);
  });

  it('reports a file:line pointer whose file is gone', () => {
    const root = fixture();
    const line = appendLine(root, 'docs/GUIDE.md', 'The rule sits at `gone.ts:12`.');
    const { out } = run(root);
    expect(out).toContain(`docs/GUIDE.md:${line}  path  gone.ts`);
  });

  it('reports a file:line pointer past the end of the file it names', () => {
    const root = fixture();
    const line = appendLine(root, 'docs/GUIDE.md', 'The rule sits at `keeper.ts:9999`.');
    const { out } = run(root);
    expect(out).toContain(`docs/GUIDE.md:${line}  path  keeper.ts:9999`);
    expect(out).toContain('lines');
  });

  it('reports a constant that occurs in no code root', () => {
    const root = fixture();
    const line = appendLine(root, 'AGENTS.md', 'Exemptions: `RETIRED_CONST`.');
    const { out } = run(root);
    expect(out).toContain(`AGENTS.md:${line}  ident  RETIRED_CONST`);
  });

  it('does not find a constant in its own udx config', () => {
    const root = fixture();
    // The config quoting the name must not be the code root it is found in.
    configure(root, { privateDirs: [['prototypes/', 'spikes, see RETIRED_CONST']] });
    const line = appendLine(root, 'AGENTS.md', 'Exemptions: `RETIRED_CONST`.');
    const { out } = run(root);
    expect(out).toContain(`AGENTS.md:${line}  ident  RETIRED_CONST`);
  });

  it('reports a link whose target file is gone', () => {
    const root = fixture();
    const line = appendLine(root, 'docs/README.md', '- [gone](./GONE.md)');
    const { out } = run(root);
    expect(out).toContain(`docs/README.md:${line}  link  ./GONE.md`);
  });

  it('reports a link fragment no heading slugifies to', () => {
    const root = fixture();
    const line = appendLine(root, 'docs/README.md', '- [gone](./GUIDE.md#no-such-heading)');
    const { out } = run(root);
    expect(out).toContain(`docs/README.md:${line}  link  ./GUIDE.md#no-such-heading`);
    expect(out).toContain('no heading in docs/GUIDE.md slugifies to #no-such-heading');
  });

  it('reports a link to a heading that only exists inside a fence', () => {
    const root = fixture();
    const line = appendLine(root, 'docs/README.md', '- [fenced](./GUIDE.md#fenced-heading)');
    const { out } = run(root);
    expect(out).toContain(`docs/README.md:${line}  link  ./GUIDE.md#fenced-heading`);
    expect(out).toContain('no heading in docs/GUIDE.md slugifies to #fenced-heading');
  });

  it("reports a link into the repo's own web view whose path or anchor is gone", () => {
    const root = fixture();
    const base = 'https://github.com/acme/fixture/blob/main';
    const file = appendLine(root, 'docs/GUIDE.md', `[gone](${base}/docs/GONE.md)`);
    const frag = appendLine(root, 'docs/GUIDE.md', `[anchor](${base}/docs/README.md#gone)`);
    const other = appendLine(
      root,
      'docs/GUIDE.md',
      '[other](https://github.com/x/y/blob/main/G.md)'
    );
    const { out } = run(root);
    expect(out).toContain(`docs/GUIDE.md:${file}  link  ${base}/docs/GONE.md`);
    expect(out).toContain(`docs/GUIDE.md:${frag}  link  ${base}/docs/README.md#gone`);
    // Another repo's file is not this tree's to answer for.
    expect(out).not.toContain(`docs/GUIDE.md:${other}`);
  });

  it('prints the findings as JSON with --json', () => {
    const root = fixture();
    const line = appendLine(root, 'AGENTS.md', 'Run `bun run no-such-script` first.');
    const { code, out } = runArgs('check', '--root', root, '--json');
    const report = JSON.parse(out);
    expect(report.findings).toEqual([
      {
        file: 'AGENTS.md',
        line,
        kind: 'script',
        what: 'no-such-script',
        why: 'not a script of the root package.json'
      }
    ]);
    expect(report.sources).toBe(5);
    expect(code).toBe(1);
  });
});

describe('udx docs check — private pointers (rule 5)', () => {
  it('reports a pointer below the working docs or a private dir in any tracked file', () => {
    const root = fixture();
    configure(root, { privateDirs: [['prototypes/', 'throwaway spikes']] });
    const code = appendLine(
      root,
      'packages/table/src/lib/thing.ts',
      `// The rule comes from ${WD}/PLAN-2026-09.md §3.`
    );
    write(root, 'packages/table/README.md', '# Table\n\nSee (prototypes/2026-05/OLD-AUDIT.md).\n');
    ignoreWorkingDocs(root);
    track(root);
    const result = run(root);
    expect(result.out).toContain(
      `packages/table/src/lib/thing.ts:${code}  private  ${WD}/PLAN-2026-09.md`
    );
    expect(result.out).toContain(
      'packages/table/README.md:3  private  prototypes/2026-05/OLD-AUDIT.md'
    );
    expect(result.out).toContain('below prototypes/ (throwaway spikes), which git does not track');
    expect(result.code).toBe(1);
  });

  it('treats working docs recorded as a gitlink as private', () => {
    // `dir/*` ignores the contents but not the folder, so `git add -A` records the nested store
    // as a gitlink; `check-ignore` then answers 128, and only the gitlink tells the store apart.
    const root = fixture();
    ignoreWorkingDocs(root, `${WD}/*`);
    write(root, `${WD}/PLAN.md`, '# Plan\n\nEnds when shipped.\n');
    const store = join(root, WD);
    git(store, 'init', '-q');
    git(store, 'add', '-A');
    git(store, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'state');
    const line = appendLine(root, 'packages/table/src/lib/thing.ts', `// See ${WD}/PLAN.md.`);
    track(root);
    const result = run(root);
    expect(result.out).toContain(`packages/table/src/lib/thing.ts:${line}  private  ${WD}/PLAN.md`);
    expect(result.code).toBe(1);
  });

  it('reports a pointer into every private dir, both config forms, working docs included', () => {
    const root = fixture();
    configure(root, { privateDirs: ['prototypes', ['scratch/', 'local notes']] });
    const all = [`${WD}/`, 'prototypes/', 'scratch/'];
    const lines = all.map((dir) =>
      appendLine(root, 'scripts/keeper.ts', `// measured in ${dir}spike/NOTES.md`)
    );
    ignoreWorkingDocs(root);
    track(root);
    const { code, out } = run(root);
    all.forEach((dir, i) => {
      expect(out).toContain(`scripts/keeper.ts:${lines[i]}  private  ${dir}spike/NOTES.md`);
    });
    expect(code).toBe(1);
  });

  it('passes the bare folder name — prose about the folder names no document', () => {
    const root = fixture();
    configure(root, { privateDirs: ['prototypes/'] });
    appendLine(root, 'scripts/keeper.ts', `// Working docs live in \`${WD}/\` (git-ignored).`);
    appendLine(root, 'scripts/keeper.ts', `// And in ${WD}/.`);
    appendLine(root, 'scripts/keeper.ts', `// Ignored as ${WD}/** by the ignore rules.`);
    appendLine(root, 'scripts/keeper.ts', '// Spikes stay in `prototypes/`.');
    ignoreWorkingDocs(root);
    track(root);
    const { code, out } = run(root);
    expect(out).toContain('0 findings');
    expect(code).toBe(0);
    // The blindness guard: a checkout the rule could not read would pass too.
    expect(Number(out.match(/(\d+) tracked files/)?.[1])).toBeGreaterThan(5);
  });

  it('asks the index: a tracked target, an UNSCANNED file and an untracked one pass', () => {
    const root = fixture();
    configure(root, { privateDirs: ['prototypes/'] });
    write(root, 'prototypes/KEPT.md', '# Kept\n');
    appendLine(root, 'scripts/keeper.ts', '// Published: prototypes/KEPT.md.');
    write(root, 'CHANGELOG.md', `# Changelog\n\n- moved ${WD}/PLAN.md\n`);
    write(root, 'packages/table/CHANGELOG.md', `# Changelog\n\n- moved ${WD}/PLAN.md\n`);
    ignoreWorkingDocs(root);
    track(root);
    // Written after `git add`: on disk, not in the index — neither published nor a source.
    write(root, 'scripts/scratch.ts', `// ${WD}/PLAN.md\n`);
    const { code, out } = run(root);
    expect(out).toContain('0 findings');
    expect(code).toBe(0);
  });

  it('reports a pointer behind `./` or `../`, and a doc-source span only once', () => {
    const root = fixture();
    const dot = appendLine(root, 'scripts/keeper.ts', `// see ./${WD}/PLAN.md`);
    const up = appendLine(root, 'scripts/keeper.ts', `// see ../${WD}/OTHER.md`);
    const span = appendLine(root, 'AGENTS.md', `Details: \`${WD}/OLD.md\`.`);
    const link = appendLine(root, 'AGENTS.md', `And [the plan](${WD}/LINKED.md).`);
    ignoreWorkingDocs(root);
    track(root);
    const { out } = run(root);
    expect(out).toContain(`scripts/keeper.ts:${dot}  private  ${WD}/PLAN.md`);
    expect(out).toContain(`scripts/keeper.ts:${up}  private  ${WD}/OTHER.md`);
    expect(out).toContain(`AGENTS.md:${span}  private  ${WD}/OLD.md`);
    expect(out).toContain(`AGENTS.md:${link}  private  ${WD}/LINKED.md`);
    // Rules 2 and 4 see the same spans as a missing path and a dead link; rule 5 owns them.
    expect(out.match(/OLD\.md/g)).toHaveLength(1);
    expect(out.match(/LINKED\.md/g)).toHaveLength(1);
  });

  it('reads a pointer out of a string literal without the escape it runs into', () => {
    const root = fixture();
    write(root, 'scripts/str.ts', `export const S = '# Log\\n\\n- moved ${WD}/PLAN.md\\n';\n`);
    ignoreWorkingDocs(root);
    track(root);
    const { out } = run(root);
    expect(out).toContain(`scripts/str.ts:1  private  ${WD}/PLAN.md  →`);
  });

  it('passes placeholders, a compound on the folder name, and a tracked target with a suffix', () => {
    const root = fixture();
    configure(root, { privateDirs: ['prototypes/'] });
    for (const text of [
      `// a placeholder: ${WD}/…`,
      `// an arrow: ${WD}/→ the plan`,
      `// a variable: ${WD}/$FILE`,
      `// a German compound: die ${WD}/-Dokumente`,
      '// an anchor: prototypes/KEPT.md#the-section',
      '// a line: prototypes/KEPT.md:12'
    ])
      appendLine(root, 'scripts/keeper.ts', text);
    write(root, 'prototypes/KEPT.md', '# Kept\n\n## The section\n');
    ignoreWorkingDocs(root);
    track(root);
    const { code, out } = run(root);
    expect(out).toContain('0 findings');
    expect(code).toBe(0);
  });

  it('does not read the private folders themselves: what they say of their own files is internal', () => {
    const root = fixture();
    configure(root, { privateDirs: ['prototypes/'] });
    // Tracked, and pointing at a file git does not track there: only an outsider's pointer counts.
    write(root, 'prototypes/NOTES.md', '# Notes\n\nSupersedes prototypes/RETIRED.md.\n');
    track(root);
    const { code, out } = run(root);
    expect(out).toContain('0 findings');
    expect(code).toBe(0);
  });

  it('asks git whether the working docs are private, of their contents, not the folder', () => {
    for (const pattern of [`${WD}/`, `${WD}/*`, `${WD}/**`]) {
      const root = fixture();
      ignoreWorkingDocs(root, pattern);
      const line = appendLine(root, 'scripts/keeper.ts', `// see ${WD}/PLAN.md`);
      track(root);
      expect(run(root).out).toContain(`scripts/keeper.ts:${line}  private  ${WD}/PLAN.md`);
    }
    // Tracked, they are ordinary: a pointer there is published like any other.
    const root = fixture();
    write(root, `${WD}/PLAN.md`, '# Plan\n\nEnds when shipped.\n');
    appendLine(root, 'scripts/keeper.ts', `// see ${WD}/PLAN.md`);
    track(root);
    const { code, out } = run(root);
    expect(out).toContain('0 findings');
    expect(code).toBe(0);
  });

  it('passes the config naming its own tracker file', () => {
    const root = fixture();
    configure(root, { tracker: `${WD}/TRACKER.md` });
    ignoreWorkingDocs(root);
    track(root);
    const { code, out } = run(root);
    expect(out).toContain('0 findings');
    expect(code).toBe(0);
  });

  it('exits 2 when a checkout cannot answer for its index, instead of reading 0 files', () => {
    const root = fixture();
    track(root);
    const proc = Bun.spawnSync([process.execPath, UDX, 'docs', 'check', '--root', root], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...ENV, GIT_DIR: join(root, 'no-such-git-dir') }
    });
    expect(proc.stderr.toString()).toContain('git ls-files failed');
    expect(proc.exitCode).toBe(2);
  });

  it('says so when the root is no checkout at all', () => {
    const { out } = run(fixture());
    expect(out).toContain('not a git checkout');
  });
});

describe('udx docs check — the layer (rules 6–11)', () => {
  it('reports the index over its budget, and its count either way', () => {
    const clean = run(fixture());
    expect(clean.out).toMatch(/AGENTS\.md: \d+ words \(no budget set\)/);
    expect(clean.code).toBe(0);

    const root = fixture();
    configure(root, { budget: 200 });
    expect(run(root).out).toMatch(/AGENTS\.md: \d+ words \(budget 200\)/);
    appendLine(root, 'AGENTS.md', 'padding '.repeat(201));
    const { code, out } = run(root);
    expect(out).toMatch(/AGENTS\.md:1 {2}budget {2}\d+ words/);
    expect(out).toContain('over the 200-word budget');
    expect(code).toBe(1);
  });

  it('reports a missing CLAUDE.md, a plain one, and one linking elsewhere', () => {
    const missing = fixture();
    unlinkSync(join(missing, 'CLAUDE.md'));
    expect(run(missing).out).toContain('CLAUDE.md  delivery  CLAUDE.md  →  missing');

    const plain = fixture();
    unlinkSync(join(plain, 'CLAUDE.md'));
    write(plain, 'CLAUDE.md', '# Claude\n\nSee AGENTS.md.\n\n```md\n@AGENTS.md\n```\n');
    const r = run(plain);
    expect(r.out).toContain('CLAUDE.md:1  delivery  CLAUDE.md  →  neither a symlink');
    expect(r.code).toBe(1);

    const elsewhere = fixture();
    unlinkSync(join(elsewhere, 'CLAUDE.md'));
    symlinkSync('docs/README.md', join(elsewhere, 'CLAUDE.md'));
    expect(run(elsewhere).out).toContain('a symlink to docs/README.md, not to AGENTS.md');
  });

  it('passes a CLAUDE.md that imports the index by its exact name, in a line or in prose', () => {
    for (const body of [
      '@AGENTS.md',
      'See @AGENTS.md for how to work here.',
      'Read @./AGENTS.md.'
    ]) {
      const root = fixture();
      unlinkSync(join(root, 'CLAUDE.md'));
      write(root, 'CLAUDE.md', `# Claude\n\n${body}\n`);
      const { code, out } = run(root);
      expect(out).toContain('0 findings');
      expect(code).toBe(0);
    }
  });

  it('does not count an import in a code span, or one naming another file', () => {
    for (const body of [
      'Write `see @AGENTS.md` there.',
      'See @AGENTS.md.bak.',
      'See @AGENTS.md-old.'
    ]) {
      const root = fixture();
      unlinkSync(join(root, 'CLAUDE.md'));
      write(root, 'CLAUDE.md', `# Claude\n\n${body}\n`);
      expect(run(root).out).toContain('CLAUDE.md:1  delivery  CLAUDE.md');
    }
  });

  it('reads the index name from the listing: Agents.md needs @Agents.md', () => {
    const root = fixture();
    unlinkSync(join(root, 'CLAUDE.md'));
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
    rmSync(join(root, 'AGENTS.md'));
    write(root, 'Agents.md', text);
    write(root, 'CLAUDE.md', '@AGENTS.md\n');
    const wrong = run(root);
    expect(wrong.out).toContain('Agents.md: ');
    expect(wrong.out).toContain('CLAUDE.md:1  delivery  CLAUDE.md');
    // The old spelling is dead on Linux, and so on macOS too: the listing answers, not the FS.
    expect(wrong.out).toContain('docs/README.md:3  link  ../AGENTS.md');
    const readme = join(root, 'docs/README.md');
    writeFileSync(readme, readFileSync(readme, 'utf-8').replace('../AGENTS.md', '../Agents.md'));
    write(root, 'CLAUDE.md', '@Agents.md\n');
    const right = run(root);
    expect(right.out).toContain('0 findings');
    expect(right.code).toBe(0);
  });

  it('does not count a negated end condition', () => {
    const root = fixture();
    write(root, `${WD}/A.md`, '# A\n\nThis plan is not permanent.\n');
    write(root, `${WD}/B.md`, '# B\n\nDas ist nicht dauerhaft.\n');
    write(root, `${WD}/C.md`, '# C\n\nEs gibt keine Endbedingung.\n');
    write(root, `${WD}/D.md`, '# D\n\nNot permanent: it ends when the wave merges.\n');
    const { out } = run(root);
    for (const f of ['A', 'B', 'C']) expect(out).toContain(`${WD}/${f}.md:1  lifecycle`);
    expect(out).not.toContain(`${WD}/D.md`);
  });

  it('takes a lowercase readme.md as the folder README', () => {
    const root = fixture();
    write(root, `${WD}/harness/readme.md`, '# Harness\n\nEnds when the wave merges.\n');
    write(root, `${WD}/harness/T01.md`, '# Task 1\n');
    const { code, out } = run(root);
    expect(out).toContain('0 findings');
    expect(code).toBe(0);
  });

  it('reads a working-docs subfolder with a README as one document', () => {
    const root = fixture();
    write(root, `${WD}/harness/README.md`, '# Harness\n\nEnds when the wave merges.\n');
    write(root, `${WD}/harness/tasks/T01.md`, '# Task 1\n\nNo end of its own.\n');
    write(root, `${WD}/loose/NOTE.md`, '# A note\n\nNo end either.\n');
    write(root, `${WD}/bare/README.md`, '# Bare\n\nNothing about its end.\n');
    write(root, `${WD}/bare/inner/X.md`, '# X\n\nCovered by the bare README.\n');
    const { out } = run(root);
    // The harness README speaks for its task files.
    expect(out).not.toContain('T01.md');
    // No README, so the file is a document of its own.
    expect(out).toContain(`${WD}/loose/NOTE.md:1  lifecycle`);
    // A README without an end condition is the finding, not the files it covers.
    expect(out).toContain(`${WD}/bare/README.md:1  lifecycle`);
    expect(out).not.toContain('X.md');
  });

  it('reports a working doc that names no end condition in its first 20 lines', () => {
    const root = fixture();
    const filler = Array.from({ length: 19 }, (_, i) => `line ${i + 2}`).join('\n');
    write(root, `${WD}/NONE.md`, '# A plan\n\nIt says nothing about its end.\n');
    write(root, `${WD}/LATE.md`, `# Late\n${filler}\nEnds when the plan ships.\n`);
    write(
      root,
      `${WD}/ON-20.md`,
      `# On 20\n${filler.split('\n').slice(0, 18).join('\n')}\nPermanent.\n`
    );
    write(root, `${WD}/GERMAN.md`, '# Plan\n\nLebt, bis die Welle gemergt ist.\n');
    write(root, `${WD}/RUNBOOK.md`, '# Runbook\n\nEnd condition: none — dauerhaft.\n');
    const { code, out } = run(root);
    expect(out).toContain(`${WD}/NONE.md:1  lifecycle  no end condition`);
    expect(out).toContain(`${WD}/LATE.md:1  lifecycle  no end condition`);
    expect(out).not.toContain('ON-20.md');
    expect(out).not.toContain('GERMAN.md');
    expect(out).not.toContain('RUNBOOK.md');
    expect(out).toMatch(/5 working docs/);
    expect(code).toBe(1);
  });

  it('reports an archive folder on disk, and one only the index still holds', () => {
    const root = fixture();
    write(root, 'docs/archive/OLD.md', '# Old\n');
    write(root, 'docs/archive/nested/_archive/OLDER.md', '# Older\n');
    write(root, `${WD}/Archived/GONE.md`, '# Gone\n\nEnds when retired.\n');
    track(root);
    rmSync(join(root, `${WD}/Archived`), { recursive: true });
    const { code, out } = run(root);
    expect(out).toContain('docs/archive/  archive  docs/archive/');
    expect(out).toContain(`${WD}/Archived/  archive  ${WD}/Archived/`);
    // The outermost only: what is inside goes with it.
    expect(out).not.toContain('_archive');
    expect(code).toBe(1);
  });

  it('reports an open checkbox in a working doc or the index, and nothing else', () => {
    const root = fixture();
    write(
      root,
      `${WD}/PLAN.md`,
      '# Plan\n\nEnds when shipped.\n\n  * [ ] a nested open item\n- [x] a done item is not open\n' +
        '```md\n- [ ] a fenced example\n```\n'
    );
    const index = appendLine(root, 'AGENTS.md', '- [ ] tidy the index');
    // A checklist in a reference doc is a template for the reader, not open work.
    appendLine(root, 'docs/GUIDE.md', '- [ ] check the page renders');
    const { code, out } = run(root);
    expect(out).toContain(`${WD}/PLAN.md:5  checkbox  * [ ] a nested open item`);
    expect(out).toContain(`AGENTS.md:${index}  checkbox  - [ ] tidy the index`);
    expect(out).toContain('outside the issue tracker');
    expect(out).not.toContain('page renders');
    expect(out).not.toContain('done item');
    expect(out).not.toContain('fenced example');
    expect(code).toBe(1);
  });

  it('passes the checkboxes of the tracker file and of an allowlisted runbook', () => {
    const root = fixture();
    configure(root, {
      tracker: `${WD}/TRACKER.md`,
      allowlist: [
        [ALLOWED, 'a verdict word'],
        [`${WD}/RELEASE.md`, 'the release runbook is a checklist by design']
      ]
    });
    write(root, `${WD}/TRACKER.md`, '# Tracker\n\nPermanent.\n\n- [ ] an item\n');
    write(root, `${WD}/RELEASE.md`, '# Release\n\nPermanent.\n\n- [ ] bump\n- [ ] tag\n');
    const { code, out } = run(root);
    expect(out).toContain('0 findings');
    expect(code).toBe(0);
  });

  it('reports a git-ignored working-docs folder that has no history of its own', () => {
    // `dir/*` and `dir/**` ignore the contents, not the folder: asked of the folder, both passed.
    for (const pattern of [`${WD}/*`, `${WD}/**`]) {
      const root = fixture();
      ignoreWorkingDocs(root, pattern);
      write(root, `${WD}/PLAN.md`, '# Plan\n\nEnds when shipped.\n');
      track(root);
      expect(run(root).out).toContain(`${WD}/  store  ${WD}/`);
    }
    const root = fixture();
    ignoreWorkingDocs(root);
    write(root, `${WD}/PLAN.md`, '# Plan\n\nEnds when shipped.\n');
    track(root);
    const bare = run(root);
    expect(bare.out).toContain(`${WD}/  store  ${WD}/`);
    expect(bare.code).toBe(1);

    // A `.git` git does not recognise is no history either.
    write(root, `${WD}/.git`, 'not a repository\n');
    expect(run(root).out).toContain(`${WD}/  store`);

    rmSync(join(root, `${WD}/.git`));
    git(join(root, WD), 'init', '-q');
    const stored = run(root);
    expect(stored.out).toContain('0 findings');
    expect(stored.code).toBe(0);
  });

  it('passes a tracked working-docs folder: its history is the repo', () => {
    const root = fixture();
    write(root, `${WD}/PLAN.md`, '# Plan\n\nEnds when shipped.\n');
    track(root);
    const { code, out } = run(root);
    expect(out).toContain('0 findings');
    expect(code).toBe(0);
  });
});

/**
 * The managed skill and scaffolds land in projects that cannot edit them, so they must never fail
 * the gate they install: whatever `udx add knowledge` writes passes `udx docs check` as written, in
 * a private repo (working docs tracked) and a public one (ignored, a repository of its own).
 */
describe('udx docs check — what `udx add knowledge` writes passes it', () => {
  for (const mode of ['private', 'public'] as const)
    it(`in a ${mode} repo`, () => {
      const root = mkdtempSync(join(tmpdir(), `udx-docs-self-${mode}-`));
      dirs.push(root);
      write(root, 'package.json', '{ "name": "project", "private": true }\n');
      write(root, 'AGENTS.md', '# Project\n\nHow to work here.\n');
      symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
      git(root, 'init', '-q');
      const add = Bun.spawnSync([process.execPath, UDX, 'add', 'knowledge', '--cwd', root], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: ENV
      });
      expect(add.exitCode).toBe(0);
      if (mode === 'public') {
        write(root, '.gitignore', `${WD}/\n`);
        git(join(root, WD), 'init', '-q');
      }
      git(root, 'add', '-A');
      const { code, out } = run(root);
      expect(out).toContain('0 findings');
      expect(Number(out.match(/(\d+) references/)?.[1])).toBeGreaterThan(10);
      expect(code).toBe(0);
    });
});

describe('udx docs check — allowlist, config and CLI', () => {
  it('reports an allowlist entry no scanned file mentions', () => {
    const root = fixture();
    const skill = join(root, '.claude/skills/probe/SKILL.md');
    writeFileSync(skill, readFileSync(skill, 'utf-8').replace(/^Verdicts:.*$/m, 'Verdicts: none.'));
    const { code, out } = run(root);
    expect(out).toMatch(new RegExp(`package\\.json:\\d+  allowlist  '${ALLOWED}'`));
    expect(out).toContain('stale');
    expect(code).toBe(1);
  });

  it('reports a file exemption once its file is gone or no longer read for checkboxes', () => {
    const root = fixture();
    configure(root, {
      allowlist: [
        [ALLOWED, 'a verdict word'],
        [`${WD}/RELEASE.md`, 'the release runbook is a checklist by design'],
        ['docs/GUIDE.md', 'a reference doc, which the checkbox rule does not read']
      ]
    });
    const { out } = run(root);
    expect(out).toContain(`allowlist  '${WD}/RELEASE.md'`);
    // It exists, but no checkbox is read there, so the entry exempts nothing.
    expect(out).toContain("allowlist  'docs/GUIDE.md'");
  });

  it('exits 2 with a precise message on a malformed config', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ budget: '3400' }, 'udx.docs.budget must be a positive integer (got "3400")'],
      [{ budget: 0 }, 'udx.docs.budget must be a positive integer'],
      [{ budjet: 3400 }, 'udx.docs.budjet is not a setting'],
      [{ privateDirs: [42] }, 'udx.docs.privateDirs[0] must be "dir" or ["dir", "reason"]'],
      [{ privateDirs: 'prototypes/' }, 'udx.docs.privateDirs must be an array'],
      [{ allowlist: [['X']] }, 'udx.docs.allowlist[0] must be ["text", "reason"]'],
      [
        {
          allowlist: [
            [ALLOWED, 'a'],
            [ALLOWED, 'b']
          ]
        },
        `udx.docs.allowlist[1] repeats "${ALLOWED}"`
      ],
      [{ tracker: 'TODO.txt' }, 'udx.docs.tracker must be "issues" or the path of a Markdown file'],
      [{ index: 'agents.md' }, 'udx.docs.index names agents.md, which is not a file here'],
      [{ sources: [] }, 'udx.docs.sources must be a non-empty array of globs'],
      [{ codeRoots: ['src', 7] }, 'udx.docs.codeRoots[1] must be a non-empty string'],
      [{ workingDocs: '../notes' }, 'udx.docs.workingDocs must be a path inside the repo']
    ];
    for (const [docs, message] of cases) {
      const root = fixture();
      configure(root, docs);
      const { code, out } = run(root);
      expect(out).toContain(message);
      expect(code).toBe(2);
    }
  });

  it('exits 2 on a package.json that is not JSON or a udx key that is not an object', () => {
    const broken = fixture();
    writeFileSync(join(broken, 'package.json'), '{ "name": ');
    expect(run(broken)).toMatchObject({ code: 2 });
    expect(run(broken).out).toContain('package.json is not valid JSON');

    const scalar = fixture();
    const pkg = JSON.parse(readFileSync(join(scalar, 'package.json'), 'utf-8'));
    writeFileSync(join(scalar, 'package.json'), JSON.stringify({ ...pkg, udx: 'docs' }));
    const r = run(scalar);
    expect(r.out).toContain('package.json: udx must be an object');
    expect(r.code).toBe(2);
  });

  it('exits 2 on a budget with no index to count', () => {
    const root = fixture();
    unlinkSync(join(root, 'CLAUDE.md'));
    rmSync(join(root, 'AGENTS.md'));
    configure(root, { budget: 100 });
    const { code, out } = run(root);
    expect(out).toContain('udx.docs.budget is set, but there is no index file');
    expect(code).toBe(2);
  });

  // Explicit over a fallback: a `--root` that names nothing must not silently check the current
  // directory and report it clean.
  it('refuses a --root with no directory behind it, or one that does not exist', () => {
    for (const args of [['--root'], ['--root', '--json']]) {
      const { code, out } = runArgs('check', ...args);
      expect(out).toContain('--root needs a directory');
      expect(code).toBe(2);
    }
    const { code, out } = runArgs('check', '--root', join(tmpdir(), 'udx-docs-no-such-dir'));
    expect(out).toContain('no such directory');
    expect(code).toBe(2);
  });

  it('refuses a --cwd with no directory behind it, for docs and every other command', () => {
    for (const args of [['--cwd'], ['--cwd', '--json']]) {
      const { code, out } = runArgs('check', ...args);
      expect(out).toContain('--cwd needs a directory');
      expect(code).toBe(2);
    }
    // A flag after `--cwd` is a missing value, never the path: otherwise the dry run is dropped.
    const proc = Bun.spawnSync([process.execPath, UDX, 'sync', '--cwd', '--dry-run'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: ENV
    });
    expect(proc.stderr.toString()).toContain('--cwd needs a directory');
    expect(proc.exitCode).toBe(2);
  });

  it('exits 2 on a missing or unknown subcommand, or a stray argument', () => {
    expect(runArgs()).toMatchObject({ code: 2 });
    const unknown = runArgs('lint');
    expect(unknown.out).toContain('Unknown docs subcommand: lint');
    expect(unknown.code).toBe(2);
    expect(runArgs('check', 'extra', '--root', fixture())).toMatchObject({ code: 2 });
  });
});
