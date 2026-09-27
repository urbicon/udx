import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { type AllowEntry, type DocsConfig, existsExact } from './config.ts';
import {
  ARCHIVE_DIR,
  BINARY,
  decode,
  EXTENSION,
  FILE_LINE,
  HEAD_LINES,
  HOST_HEAD,
  IDENT,
  LEADING_UP,
  lineRefs,
  looksLikePath,
  MAIL_OR_TEL,
  namesEndCondition,
  normalize,
  OPEN_CHECKBOX,
  PATTERN_CHARS,
  PKG_BASE,
  privatePointer,
  privateTarget,
  proseLines,
  SCRIPT_NAME,
  scriptRefs,
  skippable,
  splitFragment,
  UNSCANNED,
  WEB_URL
} from './extract.ts';
import { isOwnRepository, type Oracles, walkFiles } from './oracles.ts';

export type Kind =
  | 'script'
  | 'path'
  | 'ident'
  | 'link'
  | 'private'
  | 'budget'
  | 'delivery'
  | 'lifecycle'
  | 'archive'
  | 'checkbox'
  | 'store'
  | 'allowlist';

export interface Finding {
  file: string;
  /** 1-based; 0 when the finding is about a directory or a missing file, not a line. */
  line: number;
  kind: Kind;
  what: string;
  why: string;
}

/** A document whose references are checked. */
export interface Source {
  /** Path relative to the root, as reported — a symlinked doc reports its target. */
  display: string;
  real: string;
  /** The directory the document lives in: the base for its relative links. */
  dir: string;
  /** The workspace package it lives in, or null at the root. */
  pkg: string | null;
  text: string;
}

/** A Markdown file below the working-docs folder, as it is on disk. */
export interface WorkingDoc {
  rel: string;
  text: string;
}

/** Plain code-unit order: the output is a diff, not a listing for a reader. */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Kinds an allowlist entry may exempt by naming the file: a runbook's checklist is its point. */
const FILE_EXEMPT: ReadonlySet<Kind> = new Set<Kind>(['checkbox']);
const WORDS = /\s+/;
const CODE_SPAN = /`[^`\n]*`/g;
const REGEX_SPECIAL = /[.*+?^$|()[\]{}\\/]/g;

/** Counts references and routes every finding past the allowlist, remembering which entries answered. */
export class Collector {
  readonly findings: Finding[] = [];
  readonly hit = new Set<string>();
  references = 0;
  private readonly allow: Set<string>;

  constructor(allowlist: readonly AllowEntry[]) {
    this.allow = new Set(allowlist.map((e) => e.text));
  }

  seen(what: string): void {
    this.references++;
    if (this.allow.has(what)) this.hit.add(what);
  }

  report(finding: Finding): void {
    if (this.allow.has(finding.what)) {
      this.hit.add(finding.what);
      return;
    }
    if (FILE_EXEMPT.has(finding.kind) && this.allow.has(finding.file)) {
      this.hit.add(finding.file);
      return;
    }
    this.findings.push(finding);
  }
}

// ── Rules 1–4: the references a source doc makes ───────────────────────────────────────────────

export function referenceRules(
  o: Oracles,
  sources: readonly Source[],
  blobLink: RegExp | null,
  c: Collector
): void {
  const report = (src: Source, line: number, kind: Kind, what: string, why: string): void =>
    c.report({ file: src.display, line, kind, what, why });

  const bases = (src: Source, token: string): string[] => {
    const out = [o.root, src.dir];
    if (src.pkg && PKG_BASE.test(token)) out.push(src.pkg);
    return out;
  };

  const checkPathLike = (src: Source, line: number, token: string): void => {
    // `#alias/…` is a subpath import: package.json `imports` says where it lives, as Node reads it.
    if (token.startsWith('#')) {
      const targets = o.importTargets(token, src.pkg);
      if (targets.some((t) => o.exists(t))) return;
      report(
        src,
        line,
        'path',
        token,
        targets.length === 0
          ? 'no package.json `imports` entry maps it'
          : `no file where package.json \`imports\` maps it (${targets.map((t) => o.rel(t)).join(', ')})`
      );
      return;
    }
    for (const base of bases(src, token)) if (o.exists(resolve(base, token))) return;
    if (o.isRootAnchored(token))
      report(src, line, 'path', token, `no such file at the repo root or under ${o.rel(src.dir)}`);
    else if (o.tailHits(token).length === 0)
      report(src, line, 'path', token, 'no file with that path tail anywhere in the tree');
  };

  /**
   * The single file a `file.ts:12` pointer names, or null. Only a unique answer counts:
   * `src/index.ts:40` may match many files, and no line number is a claim about all of them.
   */
  const pointerTarget = (src: Source, file: string): string | null => {
    if (file.startsWith('#'))
      return o.importTargets(file, src.pkg).find((t) => o.exists(t)) ?? null;
    for (const base of bases(src, file)) {
      const abs = resolve(base, file);
      if (o.exists(abs)) return abs;
    }
    const hits = file.includes('/') ? o.tailHits(file) : o.filesNamed(file);
    return hits.length === 1 && hits[0] ? join(o.root, hits[0]) : null;
  };

  const checkFragment = (
    src: Source,
    line: number,
    target: string,
    file: string,
    frag: string | null
  ): void => {
    if (!frag || !file.endsWith('.md') || !o.isFile(file)) return;
    if (!o.anchors(file).has(decode(frag).toLowerCase()))
      report(src, line, 'link', target, `no heading in ${o.rel(file)} slugifies to #${frag}`);
  };

  const checkSpan = (src: Source, line: number, span: string): void => {
    // 1 — scripts. A `--filter` or `--cwd` carrying a glob or a placeholder names no single package;
    // a name with a `/` or a `.` is a file (`bun run scripts/x.ts`), the path rule's.
    for (const { name, filter, cwd } of scriptRefs(span)) {
      if (!SCRIPT_NAME.test(name)) continue;
      if (filter !== null) {
        if (filter === '' || PATTERN_CHARS.test(filter) || filter.startsWith('!')) continue;
        c.seen(name);
        const dir = o.packageDir(filter);
        if (!dir)
          report(
            src,
            line,
            'script',
            `--filter=${filter}`,
            'no workspace package of that name or ./path'
          );
        else if (!o.scriptsOf(dir)?.has(name))
          report(src, line, 'script', name, `not a script of ${o.rel(dir)}/package.json`);
        continue;
      }
      if (cwd !== null) {
        if (cwd === '' || PATTERN_CHARS.test(cwd)) continue;
        c.seen(name);
        const dir = resolve(o.root, cwd);
        const scripts = o.scriptsOf(dir);
        if (!scripts) report(src, line, 'script', `--cwd=${cwd}`, 'no package.json there');
        else if (!scripts.has(name))
          report(src, line, 'script', name, `not a script of ${o.rel(dir)}/package.json`);
        continue;
      }
      c.seen(name);
      // A doc inside a workspace package may mean that package's scripts: it does not say where it
      // is run, so either package.json answers.
      if (o.scriptsOf(o.root)?.has(name) || (src.pkg && o.scriptsOf(src.pkg)?.has(name))) continue;
      report(
        src,
        line,
        'script',
        name,
        src.pkg
          ? `not a script of the root package.json or ${o.rel(src.pkg)}/package.json`
          : 'not a script of the root package.json'
      );
    }

    // 3 — identifiers. The whole span, never a word inside a sentence.
    const ident = span.trim();
    if (IDENT.test(ident)) {
      c.seen(ident);
      if (!o.identifiers().has(ident)) report(src, line, 'ident', ident, o.corpusName());
      return;
    }

    // 2 — paths and file:line pointers
    for (const raw of span.split(WORDS)) {
      const token = normalize(raw);
      // A scheme-less URL (`example.org/w/api.php`) in a span names a site, not a repo path. A
      // link spelled so is a relative link, and stays the link rule's.
      if (skippable(token) || HOST_HEAD.test(token)) continue;
      const pointer = token.match(FILE_LINE);
      const file = pointer?.[1];
      if (pointer && file && EXTENSION.test(file)) {
        c.seen(file);
        if (file.includes('/') || file.startsWith('#')) checkPathLike(src, line, file);
        else if (!o.hasFileNamed(file)) {
          report(src, line, 'path', file, 'no file of that name in the tree');
          continue;
        }
        // The line half of the pointer, where the tree names one file: a pointer into a file that
        // has since been cut short is as dead as one into a file that is gone.
        const target = pointerTarget(src, file);
        const wanted = Number(pointer[3] ?? pointer[2]);
        const lines = target ? o.lineCount(target) : 0;
        if (target && lines > 0 && wanted > lines)
          report(src, line, 'path', token, `${o.rel(target)} has ${lines} lines`);
        continue;
      }
      if (!looksLikePath(token)) continue;
      c.seen(token);
      checkPathLike(src, line, token);
    }
  };

  const checkLink = (src: Source, line: number, target: string): void => {
    if (MAIL_OR_TEL.test(target)) return;
    if (WEB_URL.test(target)) {
      const m = blobLink ? target.match(blobLink) : null;
      if (!m) return;
      const [path, frag] = splitFragment(m[1] ?? '');
      c.seen(path);
      const abs = join(o.root, path);
      if (!o.exists(abs)) report(src, line, 'link', target, `no such file: ${path}`);
      else checkFragment(src, line, target, abs, frag);
      return;
    }
    const [path, frag] = splitFragment(target);
    if (path === '') {
      if (!frag) return;
      c.seen(target);
      checkFragment(src, line, target, src.real, frag);
      return;
    }
    if (skippable(normalize(path))) return;
    c.seen(path);
    // `my%20doc.md` is the file `my doc.md`, as GitHub resolves it.
    const abs = resolve(src.dir, decode(path));
    if (!o.exists(abs))
      report(src, line, 'link', target, `no such file relative to ${o.rel(src.dir)}`);
    else checkFragment(src, line, target, abs, frag);
  };

  for (const src of sources)
    for (const [n, line] of proseLines(src.text)) {
      const { links, spans } = lineRefs(line);
      for (const link of links) checkLink(src, n, link);
      for (const span of spans) checkSpan(src, n, span);
    }
}

// ── Rule 5: pointers into the private directories, in every tracked file ───────────────────────

/** Returns how many tracked files it read — 0 outside a checkout, which is how a blind run shows. */
export function privateRule(
  o: Oracles,
  config: DocsConfig,
  tracked: ReadonlySet<string>,
  c: Collector
): number {
  // Nothing private — a tracked working-docs folder and no `privateDirs` — is nothing to point into.
  const pointer =
    config.privateDirs.length > 0 ? privatePointer(config.privateDirs.map((d) => d.dir)) : null;
  const whyOf = new Map(config.privateDirs.map((d) => [d.dir, d.why]));
  const published = (target: string): boolean => {
    if (tracked.has(target)) return true;
    const dir = target.endsWith('/') ? target : `${target}/`;
    for (const p of tracked) if (p.startsWith(dir)) return true;
    return false;
  };

  // A folder git tracks anything in is ordinary for its tracked files; only its absent ones are dead.
  const trackedBelow = new Set(
    config.privateDirs
      .filter((d) => [...tracked].some((p) => p.startsWith(d.dir)))
      .map((d) => d.dir)
  );

  let scanned = 0;
  for (const path of [...tracked].sort(cmp)) {
    if (BINARY.test(path) || UNSCANNED.some(([re]) => re.test(path))) continue;
    // What a private folder says about its own files is internal; the rule keeps everything else
    // from pointing in.
    if (config.privateDirs.some((d) => path.startsWith(d.dir))) continue;
    // Null for a tracked symlink too: git tracks its target on its own, and reading both would
    // report every pointer twice.
    const text = o.text(path);
    if (text === null) continue;
    scanned++;
    if (pointer === null) continue;
    for (const [i, line] of text.split('\n').entries())
      for (const m of line.matchAll(pointer)) {
        const dir = m[2] ?? '';
        const target = privateTarget(m[1] ?? '', dir);
        if (target === null) continue;
        // The config naming its own tracker file is configuration, not a pointer for a reader.
        if (path === 'package.json' && target === config.tracker) continue;
        c.seen(target);
        if (published(target)) continue;
        const why = whyOf.get(dir);
        const where = `below ${dir}${why ? ` (${why})` : ''}`;
        c.report({
          file: path,
          line: i + 1,
          kind: 'private',
          what: target,
          why: trackedBelow.has(dir)
            ? `${where}, where git tracks no such file`
            : `${where}, which git does not track — it resolves for nobody but the maintainer`
        });
      }
  }
  return scanned;
}

// ── Rules 6–11: the shape of the knowledge layer ───────────────────────────────────────────────

export function wordCount(text: string): number {
  return text.trim().split(WORDS).filter(Boolean).length;
}

/** 6 — the index is read in full by every session, so its length is a cost every session pays. */
export function budgetRule(config: DocsConfig, words: number, c: Collector): void {
  if (config.index === null || config.budget === null || words <= config.budget) return;
  c.report({
    file: config.index,
    line: 1,
    kind: 'budget',
    what: `${words} words`,
    why: `over the ${config.budget}-word budget every session pays in full`
  });
}

/** 7 — Claude Code loads `CLAUDE.md`, never `AGENTS.md`: an AGENTS-named index must be reached from it. */
export function deliveryRule(o: Oracles, config: DocsConfig, c: Collector): void {
  const index = config.index;
  if (index === null || basename(index).toLowerCase() !== 'agents.md') return;
  const report = (line: number, why: string): void =>
    c.report({ file: 'CLAUDE.md', line, kind: 'delivery', what: 'CLAUDE.md', why });
  const fix = `make it a symlink to ${index} or import it with @${index}`;

  if (!existsExact(o.root, 'CLAUDE.md')) {
    report(0, `missing — Claude Code loads CLAUDE.md, not ${index}; ${fix}`);
    return;
  }
  const claude = join(o.root, 'CLAUDE.md');
  if (lstatSync(claude).isSymbolicLink()) {
    let real: string | null = null;
    try {
      real = realpathSync(claude);
    } catch {
      /* dangling */
    }
    if (real === realpathSync(join(o.root, index))) return;
    report(0, `a symlink to ${real ? o.rel(real) : 'nothing'}, not to ${index}; ${fix}`);
    return;
  }
  // Claude Code resolves `@path` anywhere in the prose ("See @AGENTS.md for …"), but not inside a
  // code span or a fenced block. The name must end there: `@AGENTS.md.bak` is another file.
  const esc = index.replace(REGEX_SPECIAL, '\\$&');
  const reaches = new RegExp(`(?:^|\\s)@(?:\\./)?${esc}(?![\\w/-])(?!\\.\\w)`);
  for (const [, line] of proseLines(readFileSync(claude, 'utf8')))
    if (reaches.test(line.replace(CODE_SPAN, ' '))) return;
  report(1, `neither a symlink to ${index} nor a file that imports @${index}; ${fix}`);
}

/**
 * 8 — a working doc that does not say when it ends never retires. A subfolder of the working docs
 * that holds a `README.md` is one document — a harness of many task files retires as a whole — so
 * its README carries the end condition for everything below it, and the outermost such folder
 * decides. A README counts in any case (`readme.md` too). A file directly in the working docs, and
 * one in a subfolder without a README, is a document of its own. A marker right behind a negation
 * ("not permanent", "nicht dauerhaft") does not count.
 */
export function lifecycleRule(
  o: Oracles,
  config: DocsConfig,
  docs: readonly WorkingDoc[],
  c: Collector
): void {
  const wd = config.workingDocs;
  const readme = new Map<string, string | null>();
  const readmeOf = (folder: string): string | null => {
    let hit = readme.get(folder);
    if (hit === undefined) {
      hit = o.readmeOf(join(o.root, folder));
      readme.set(folder, hit);
    }
    return hit;
  };
  /** The README that speaks for `rel`, or `rel` itself. */
  const documentOf = (rel: string): string => {
    const folders = rel
      .slice(wd.length + 1)
      .split('/')
      .slice(0, -1);
    let folder = wd;
    for (const segment of folders) {
      folder = `${folder}/${segment}`;
      const name = readmeOf(folder);
      if (name) return `${folder}/${name}`;
    }
    return rel;
  };
  for (const doc of docs) {
    if (documentOf(doc.rel) !== doc.rel) continue;
    const head = doc.text.split('\n').slice(0, HEAD_LINES).join('\n');
    if (namesEndCondition(head)) continue;
    c.report({
      file: doc.rel,
      line: 1,
      kind: 'lifecycle',
      what: 'no end condition',
      why: `none in its first ${HEAD_LINES} lines ("Ends when …", "End condition", "permanent", "Endbedingung", "lebt, bis …", "dauerhaft")`
    });
  }
}

/** 9 — the version history is the archive; a folder beside it is a second, unqueried copy. */
export function archiveRule(
  o: Oracles,
  config: DocsConfig,
  tracked: ReadonlySet<string>,
  c: Collector
): void {
  const roots = [...new Set(['docs', config.workingDocs])];
  const found = new Set<string>();
  const below = (root: string, rest: string[]): void => {
    let acc = root;
    for (const segment of rest) {
      acc = `${acc}/${segment}`;
      if (ARCHIVE_DIR.test(segment)) {
        found.add(`${acc}/`);
        return;
      }
    }
  };
  for (const root of roots) {
    const abs = join(o.root, root);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      /* not on disk */
    }
    if (isDir)
      for (const p of walkFiles(o.root, root, true))
        if (p.endsWith('/')) below(root, p.slice(root.length + 1, -1).split('/'));
    for (const p of tracked)
      if (p.startsWith(`${root}/`))
        below(
          root,
          p
            .slice(root.length + 1)
            .split('/')
            .slice(0, -1)
        );
  }
  // The outermost only: everything inside it goes with it.
  const dirs = [...found].filter((d) => ![...found].some((e) => e !== d && d.startsWith(e)));
  for (const dir of dirs)
    c.report({
      file: dir,
      line: 0,
      kind: 'archive',
      what: dir,
      why: 'an archive folder — retire a document with `git rm`; the history is the archive'
    });
}

/**
 * 10 — an open checkbox outside the tracker is a second tracker nobody queries. It is read where
 * to-do lists hide: the working docs and the index. A checklist in a reference doc or a skill is
 * a template for the reader to copy, not a list of open work, so those are not read.
 */
export function checkboxRule(
  docs: ReadonlyArray<{ file: string; text: string }>,
  config: DocsConfig,
  c: Collector
): void {
  const why = config.tracker
    ? `an open item outside ${config.tracker}, the tracker`
    : 'an open item outside the issue tracker — a second list is a second tracker';
  for (const doc of docs) {
    if (doc.file === config.tracker) continue;
    for (const [n, line] of proseLines(doc.text))
      if (OPEN_CHECKBOX.test(line))
        c.report({ file: doc.file, line: n, kind: 'checkbox', what: line.trim(), why });
  }
}

/**
 * 11 — a git-ignored working-docs folder without its own history makes every retirement final.
 * `ignored` is git's answer for the folder's contents (`gitIgnoresContents`).
 */
export function storeRule(o: Oracles, config: DocsConfig, ignored: boolean, c: Collector): void {
  const dir = join(o.root, config.workingDocs);
  try {
    if (!statSync(dir).isDirectory()) return;
  } catch {
    return;
  }
  if (!ignored) return;
  if (isOwnRepository(dir)) return;
  c.report({
    file: `${config.workingDocs}/`,
    line: 0,
    kind: 'store',
    what: `${config.workingDocs}/`,
    why: 'git-ignored and not a git repository of its own — retiring a working doc there is an irreversible delete'
  });
}

/** The private-dir prefix a `path`/`link` finding names, for the one-finding-per-pointer rule. */
export function namesPrivateDir(config: DocsConfig, what: string): boolean {
  const bare = what.replace(LEADING_UP, '');
  return config.privateDirs.some((d) => bare.startsWith(d.dir));
}
