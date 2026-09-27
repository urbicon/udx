/**
 * udx docs check — does every reference the instruction docs make still resolve, does any tracked
 * file point where nobody else can follow, and does the knowledge layer keep its shape? Real
 * systems answer, never a model of them:
 *
 *   1. `package.json` — for every `bun run <name>` span the root scripts (in a workspace package's
 *      doc, that package's too: the doc does not say where it is run); where the span passes
 *      `--filter`/`-F` (before or after `run`) the scripts of the package Bun would pick — a
 *      workspace package with exactly that `name`, or the workspace at that `./path` — and where it
 *      passes `--cwd` that directory's. Bun's other flags (`--bun` …) are read as flags, never as a
 *      script name.
 *   2. the file tree — for every backtick span shaped like a repo path and for every `file.ts:123`
 *      pointer; a `#alias/…` subpath import through `package.json` `imports`, as Node maps it.
 *      `git check-ignore` decides the one case the tree cannot: a path that is absent by design (a
 *      generated file, a built `dist/`) is unverifiable, not broken.
 *   3. every tracked file but the docs being checked (every identifier would match itself there),
 *      the working docs, binaries and the `UNSCANNED` kinds — word-boundary-grepped for every
 *      `UPPER_SNAKE_CASE` span, so a deleted constant stops being documented as a thing an agent
 *      then looks for. An identifier lives in `.env.example`, a shell hook or a CLI as readily as
 *      in `src/`, so no directory list decides. Configured `codeRoots` restrict it; without a
 *      checkout, the tree on disk stands in for the index.
 *   4. the target document's anchors — its headings (ATX and setext) slugified the way GitHub
 *      does, and its HTML `id`/`name` attributes — for every link: inline (a `<…>` target, a
 *      `"…"`, `'…'` or `(…)` title), a reference definition (`[ref]: file.md#anchor`), and a link
 *      into this repo's own web view (the prefix comes from `package.json` `repository`).
 *      Percent-encoding is decoded first, as GitHub does.
 *   5. git's index — `git ls-files` — for every tracked file outside them, code included, that
 *      names a path *below* a private directory: the `privateDirs`, and the working-docs folder
 *      when git ignores its contents (asked of a file inside it, which is what `dir/*` ignores).
 *      What a private folder says about its own files is internal. For them rule
 *      2's "absent by design" flips into "dead for everyone but the maintainer", and a pointer in a
 *      comment ships with a tarball as readily as one in a doc. The index decides what is
 *      published: a pointer to a file git tracks there is fine, anything else is a finding. The
 *      bare folder name and a placeholder are not pointers (`privateTarget`); `UNSCANNED` lists
 *      the kinds of tracked file this rule does not read, one reason each. A checkout whose index
 *      git cannot read exits 2 rather than passing on zero files.
 *   6.–11. the layer's shape: the index's word count against `budget`; `CLAUDE.md` reaching an
 *      AGENTS-named index (Claude Code loads `CLAUDE.md`, not `AGENTS.md`); every working doc
 *      naming its end condition in its head, not negated (a subfolder with a README is one
 *      document, and its README speaks for it); no archive folder below `docs/` or the working docs,
 *      on disk or in the index (the history is the archive); no open checkbox in a working doc or
 *      the index outside the one tracker (a checklist in a reference doc is a template, not open
 *      work); and a git-ignored working-docs folder being a git repository of its own, so that
 *      retiring a doc is never an irreversible delete.
 *
 * It owns existence and shape, nothing else. A path that exists but is the wrong one, a count that
 * has drifted, two docs that contradict each other, a rule that no longer holds: all of that is the
 * review's, and a green run says nothing about it. The split is worth having because the existence
 * half is the half that rots on every rename, and it needs no reader.
 *
 * Rules 1–4 extract narrowly, because a false positive is paid for in allowlist entries: inline
 * code spans only (never fenced blocks, which close as CommonMark closes them: on the opening
 * character, at least as many times), a path only when the span carries a `/` and ends in `/` or
 * an alphabetic extension, and never a span carrying `*`, `<`, `>`, `{`, `}`, `…`, `$`, `?`, `|` or
 * `...` — a pattern or a placeholder is not a claim that a file exists. A span inside a link's
 * label is skipped too: the target is the claim, the label only names it. Rule 5 reads every line,
 * fences and comments included: a path below a private directory is a pointer wherever it is
 * written. Existence is asked case-exactly, of the directory listing: macOS answers a wrong-case
 * spelling with yes, the Linux CI with no, and the listing is the answer both agree on.
 *
 * The docs name a file by as much of its path as identifies it (`Tab/tab.context.ts`), so a token
 * is resolved against the root, the document's own directory, its workspace package, and finally
 * as a path tail anywhere in the tree. A token whose FIRST segment is a real top-level directory is
 * a root-anchored claim and gets no tail — that is what keeps `scripts/lint.ts` a finding while the
 * file sits in `packages/x/scripts/`. The tail is a weaker question than it looks: it says such a
 * file exists, not that the document points at the right one — which one is the review's. The tree
 * index leaves out installed and built trees and every nested repository (a worktree, a
 * working-docs store), which are not this repo's files.
 *
 * It reads the tree that is on disk, so a built tree can answer "exists" where an unbuilt one has
 * only `git check-ignore`'s "absent by design": a CI run without a build is the strict one. The
 * working-docs folder of a public repo is git-ignored and exists only in the maintainer's checkout,
 * so the rules that read it (end conditions, most of the checkbox rule, the store) run only there.
 * That is by design: CI has nothing to read, and what is not there cannot be wrong for anyone.
 * Whether the folder is private is git's answer, never a setting: ignored, it is a store of its own
 * that nothing tracked may point into; tracked, its tracked files are as published as any other.
 *
 * The allowlist exempts a reference by its literal text, one reason per entry (an open checkbox
 * also by the working doc it sits in, such as a runbook's checklist). An entry no scanned file mentions any more is itself a finding.
 * Stale means "nothing mentions the text", not "suppressed no finding": the findings an entry
 * suppresses depend on a tree this check does not control (a built `dist/`, a working-docs folder
 * that exists only in one checkout), and a list that flips with that is worse than none. The cost
 * is that an entry can go inert without going stale. The `udx` section of `package.json` is left out
 * of the identifier grep — otherwise the entry naming a constant would be the source it is found in.
 *
 * Exit 0 clean, 1 on any finding, 2 on a malformed config or argument, or a checkout whose index git
 * cannot read.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DocsCheckError, type DocsConfig, loadProject } from './config.ts';
import { repoBlobLink } from './extract.ts';
import {
  gitIgnored,
  gitIgnoresContents,
  gitTracked,
  Oracles,
  SKIP_DIRS,
  walkFiles
} from './oracles.ts';
import {
  archiveRule,
  budgetRule,
  Collector,
  checkboxRule,
  cmp,
  deliveryRule,
  type Finding,
  lifecycleRule,
  namesPrivateDir,
  privateRule,
  referenceRules,
  type Source,
  storeRule,
  type WorkingDoc,
  wordCount
} from './rules.ts';

export { DocsCheckError } from './config.ts';
export type { Finding, Kind } from './rules.ts';

export interface Report {
  /** The instruction index, repo-relative; null when the root has none. */
  index: string | null;
  words: number;
  budget: number | null;
  sources: number;
  references: number;
  /** Tracked files the private rule read — 0 outside a git checkout, which is how a blind run shows. */
  tracked: number;
  /** Working docs on disk that the lifecycle and checkbox rules read. */
  workingDocs: number;
  /** Whether git answered for the index at all. */
  checkout: boolean;
  findings: Finding[];
}

function resolveRoot(given: string): string {
  // Through the symlinks first: a source's own path comes back from `realpathSync`, and a root that
  // did not would make every display path relative to a different spelling of the same directory.
  let root: string;
  try {
    root = realpathSync(resolve(given));
  } catch {
    throw new DocsCheckError(`no such directory: ${given}`);
  }
  if (!statSync(root).isDirectory()) throw new DocsCheckError(`not a directory: ${given}`);
  return root;
}

/** Below the working docs or a private folder: never a source, never code for the identifier grep. */
function belowPrivate(config: DocsConfig, rel: string): boolean {
  return (
    rel.startsWith(`${config.workingDocs}/`) ||
    config.privateDirs.some((d) => rel.startsWith(d.dir))
  );
}

function collectSources(o: Oracles, config: DocsConfig): Source[] {
  const isPrivate = (rel: string): boolean => belowPrivate(config, rel);
  const seen = new Set<string>();
  const sources: Source[] = [];
  // `followSymlinks`, or a symlinked doc is silently not a source: a plain scan counts a symlink
  // as "not a file" and drops it.
  for (const pattern of config.sources)
    for (const match of new Bun.Glob(pattern).scanSync({
      cwd: o.root,
      onlyFiles: true,
      followSymlinks: true,
      dot: true
    })) {
      if (match.split('/').some((s) => SKIP_DIRS.has(s)) || isPrivate(match)) continue;
      let real: string;
      try {
        real = realpathSync(join(o.root, match));
      } catch {
        continue;
      }
      // A symlinked doc is checked once, at its target, so a finding names the file one edits.
      if (seen.has(real)) continue;
      seen.add(real);
      const inside = relative(o.root, real);
      const display = inside.startsWith('..') || isAbsolute(inside) ? match : inside;
      if (isPrivate(display)) continue;
      sources.push({
        display,
        real,
        dir: dirname(real),
        pkg: o.workspaceOf(real),
        text: readFileSync(real, 'utf8')
      });
    }
  return sources.sort((a, b) => cmp(a.display, b.display));
}

function readWorkingDocs(o: Oracles, config: DocsConfig): WorkingDoc[] {
  const dir = join(o.root, config.workingDocs);
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  const docs: WorkingDoc[] = [];
  for (const rel of walkFiles(o.root, config.workingDocs).sort(cmp)) {
    if (!rel.endsWith('.md')) continue;
    try {
      docs.push({ rel, text: readFileSync(join(o.root, rel), 'utf8') });
    } catch {
      /* unreadable — nothing to check */
    }
  }
  return docs;
}

export function check(given: string): Report {
  const root = resolveRoot(given);
  const project = loadProject(root);
  const o = new Oracles(root, project);

  // A checkout whose index git cannot read would otherwise pass with "0 tracked files"; only a
  // root that is no checkout at all may answer empty.
  const index = gitTracked(root);
  if (index === null && existsSync(join(root, '.git')))
    throw new DocsCheckError(
      `git ls-files failed in ${root} — the private rule cannot read the index`
    );
  const tracked = index ?? new Set<string>();

  // Private or ordinary is git's answer: ignored, the working docs are a store nothing tracked may
  // point into; tracked, they are published like any other file. One answer serves every rule.
  // `ls-files` names a folder itself only as a gitlink — a nested repository recorded in the outer
  // index (`dir/*` ignores the contents, `git add -A` then records the store) — whose contents
  // are published as little as an ignored folder's.
  const wdIgnored =
    gitIgnoresContents(root, project.config.workingDocs) || tracked.has(project.config.workingDocs);
  const wdDir = `${project.config.workingDocs}/`;
  const config: DocsConfig = {
    ...project.config,
    privateDirs:
      wdIgnored && !project.config.privateDirs.some((d) => d.dir === wdDir)
        ? [{ dir: wdDir, why: null }, ...project.config.privateDirs]
        : project.config.privateDirs
  };
  const c = new Collector(config.allowlist);

  const sources = collectSources(o, config);
  const sourcePaths = new Set(sources.map((s) => s.display));
  o.scopeCorpus(index, (rel) => sourcePaths.has(rel) || belowPrivate(config, rel));
  referenceRules(o, sources, repoBlobLink(project.pkg?.repository), c);
  const scanned = privateRule(o, config, tracked, c);

  const indexText = config.index ? readFileSync(join(root, config.index), 'utf8') : '';
  const words = config.index ? wordCount(indexText) : 0;
  const workingDocs = readWorkingDocs(o, config);
  budgetRule(config, words, c);
  deliveryRule(o, config, c);
  lifecycleRule(o, config, workingDocs, c);
  archiveRule(o, config, tracked, c);
  const listDocs = [
    ...(config.index && !workingDocs.some((d) => d.rel === config.index)
      ? [{ file: config.index, text: indexText }]
      : []),
    ...workingDocs.map((d) => ({ file: d.rel, text: d.text }))
  ];
  checkboxRule(listDocs, config, c);
  storeRule(o, config, wdIgnored, c);

  // A path git ignores is absent by design — a generated file, a working-docs folder that lives
  // only in one checkout. The tree cannot answer for it, so neither does this check.
  const ignored = gitIgnored(
    root,
    c.findings.filter((f) => f.kind === 'path').map((f) => f.what)
  );
  // The private rule owns a path below a private directory: where it reported one, the `path` or
  // `link` finding rules 2 and 4 raised at the same line is the same pointer a second time.
  const privateAt = new Set(
    c.findings.filter((f) => f.kind === 'private').map((f) => `${f.file}:${f.line}`)
  );
  const kept = c.findings.filter(
    (f) =>
      !(f.kind === 'path' && ignored.has(f.what)) &&
      !(
        (f.kind === 'path' || f.kind === 'link') &&
        privateAt.has(`${f.file}:${f.line}`) &&
        namesPrivateDir(config, f.what)
      )
  );

  // An entry exempting a doc's checklist by the doc's path is live while the checkbox rule reads
  // that doc — or while git ignores it, since then it is absent by design wherever it is not read.
  const read = new Set(listDocs.map((d) => d.file));
  const unmentioned = config.allowlist.filter((e) => !c.hit.has(e.text) && !read.has(e.text));
  const absentByDesign = gitIgnored(
    root,
    unmentioned.filter((e) => e.text.endsWith('.md')).map((e) => e.text)
  );
  const pkgLines = project.pkgText?.split('\n') ?? [];
  const listAt = pkgLines.findIndex((l) => l.includes('"allowlist"'));
  for (const entry of unmentioned) {
    if (absentByDesign.has(entry.text)) continue;
    const quoted = JSON.stringify(entry.text);
    const at = pkgLines.findIndex((l, i) => i >= listAt && l.includes(quoted));
    kept.push({
      file: 'package.json',
      line: at === -1 ? 1 : at + 1,
      kind: 'allowlist',
      what: `'${entry.text}'`,
      why: `stale — no scanned file mentions it any more (${entry.why})`
    });
  }

  kept.sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.what, b.what));
  return {
    index: config.index,
    words,
    budget: config.budget,
    sources: sources.length,
    references: c.references,
    tracked: scanned,
    workingDocs: workingDocs.length,
    checkout: index !== null,
    findings: kept
  };
}
