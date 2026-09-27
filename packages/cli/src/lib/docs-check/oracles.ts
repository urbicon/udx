import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { PackageJson } from '../detect.ts';
import { gitIgnored, gitIgnoresContents, runGit } from '../git.ts';
import { resolveWorkspaces } from '../workspace.ts';
import type { Project } from './config.ts';
import { anchors, BINARY, IDENT_WORD, UNSCANNED } from './extract.ts';

/** Never read, never indexed: installed, built or generated trees, and git's own. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.svelte-kit',
  '.git',
  'coverage'
]);

const TRAILING_SLASHES = /\/+$/;

/**
 * Every file below `start` (repo-relative, `''` for the root), as repo-relative paths. A directory
 * holding a `.git` of its own is another repository — a nested worktree, a working-docs store — and
 * not part of this tree; `start` itself is exempt, so a store can be walked on purpose. A symlinked
 * file counts, a symlinked directory is not entered (a cycle would never end).
 */
export function walkFiles(root: string, start: string, withDirs = false): string[] {
  const out: string[] = [];
  const visit = (rel: string, top: boolean): void => {
    const abs = rel === '' ? root : join(root, rel);
    if (!top && existsSync(join(abs, '.git'))) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (withDirs) out.push(`${path}/`);
        visit(path, false);
      } else if (e.isFile()) out.push(path);
      else if (e.isSymbolicLink()) {
        try {
          if (statSync(join(root, path)).isFile()) out.push(path);
        } catch {
          /* a dangling link names nothing */
        }
      }
    }
  };
  visit(start, true);
  return out;
}

/**
 * The files git tracks — what the repo publishes — or null when git cannot say (no checkout, no
 * git, a broken `GIT_DIR`). The caller decides which of those is an error.
 */
export function gitTracked(root: string): Set<string> | null {
  const r = runGit(root, ['ls-files', '-z']);
  if (r === null || r.code !== 0) return null;
  return new Set(r.stdout.split('\0').filter(Boolean));
}

/** Whether `dir` is the top of a git repository of its own — git's answer, not a `.git` sighting. */
export function isOwnRepository(dir: string): boolean {
  if (!existsSync(join(dir, '.git'))) return false;
  const r = runGit(dir, ['rev-parse', '--show-toplevel']);
  if (r === null || r.code !== 0) return false;
  try {
    return realpathSync(r.stdout.trim()) === realpathSync(dir);
  } catch {
    return false;
  }
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (typeof value === 'object' && value !== null)
    return Object.values(value).flatMap(stringLeaves);
  return [];
}

/** The systems the reference rules ask, each read once and only when a rule needs it. */
export class Oracles {
  readonly root: string;
  private readonly project: Project;
  private readonly listings = new Map<string, Set<string> | null>();
  private readonly manifests = new Map<string, PackageJson | null>();
  private readonly slugs = new Map<string, Set<string>>();
  private readonly texts = new Map<string, string | null>();
  private readonly lines = new Map<string, number>();
  private workspaceDirs: string[] | null = null;
  private workspaceNames: Map<string, string> | null = null;
  private scope: { tracked: ReadonlySet<string> | null; exclude: (rel: string) => boolean } | null =
    null;
  private identWords: Set<string> | null = null;
  private rootDirs: Set<string> | null = null;
  private index: { files: Map<string, string[]>; dirs: Map<string, string[]> } | null = null;

  constructor(root: string, project: Project) {
    this.root = root;
    this.project = project;
  }

  rel(abs: string): string {
    return relative(this.root, abs) || '.';
  }

  private listing(dir: string): Set<string> | null {
    let hit = this.listings.get(dir);
    if (hit === undefined) {
      try {
        hit = new Set(readdirSync(dir));
      } catch {
        hit = null;
      }
      this.listings.set(dir, hit);
    }
    return hit;
  }

  /**
   * Whether an absolute path exists spelled exactly so. `existsSync` alone says yes to a wrong-case
   * spelling on macOS and no on Linux, where CI runs; below the root the listing decides.
   */
  exists(abs: string): boolean {
    const rel = relative(this.root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return existsSync(abs);
    let dir = this.root;
    for (const segment of rel === '' ? [] : rel.split('/')) {
      if (!this.listing(dir)?.has(segment)) return false;
      dir = join(dir, segment);
    }
    return existsSync(abs);
  }

  /** The name a folder lists its README under, in any case (`README.md`, `readme.md`), or null. */
  readmeOf(abs: string): string | null {
    const names = this.listing(abs);
    if (!names) return null;
    for (const name of [...names].sort()) if (name.toLowerCase() === 'readme.md') return name;
    return null;
  }

  isFile(abs: string): boolean {
    try {
      return statSync(abs).isFile();
    } catch {
      return false;
    }
  }

  private tree(): { files: Map<string, string[]>; dirs: Map<string, string[]> } {
    if (this.index) return this.index;
    const files = new Map<string, string[]>();
    const dirs = new Map<string, string[]>();
    const push = (map: Map<string, string[]>, path: string): void => {
      const list = map.get(basename(path));
      if (list) list.push(path);
      else map.set(basename(path), [path]);
    };
    for (const p of walkFiles(this.root, '', true)) {
      if (p.endsWith('/')) push(dirs, p.slice(0, -1));
      else push(files, p);
    }
    this.index = { files, dirs };
    return this.index;
  }

  /** Files (or, for a token ending in `/`, directories) whose path ends in `token`. */
  tailHits(token: string): string[] {
    const isDir = token.endsWith('/');
    const t = token.replace(TRAILING_SLASHES, '');
    if (t === '') return [];
    const map = isDir ? this.tree().dirs : this.tree().files;
    return (map.get(basename(t)) ?? []).filter((p) => p === t || p.endsWith(`/${t}`));
  }

  hasFileNamed(name: string): boolean {
    return this.tree().files.has(name);
  }

  filesNamed(name: string): string[] {
    return this.tree().files.get(name) ?? [];
  }

  /** A token whose first segment is a real top-level directory is a claim about the root. */
  isRootAnchored(token: string): boolean {
    this.rootDirs ??= new Set(
      readdirSync(this.root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'node_modules')
        .map((e) => e.name)
    );
    return this.rootDirs.has(token.split('/')[0] ?? '');
  }

  /** A directory's `package.json`, parsed; null when it has none or it does not parse. */
  private manifest(dir: string): PackageJson | null {
    if (dir === this.root) return this.project.pkg;
    let hit = this.manifests.get(dir);
    if (hit === undefined) {
      try {
        hit = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
      } catch {
        hit = null;
      }
      this.manifests.set(dir, hit);
    }
    return hit;
  }

  scriptsOf(dir: string): Set<string> | null {
    const pkg = this.manifest(dir);
    return pkg ? new Set(Object.keys(pkg.scripts ?? {})) : null;
  }

  /**
   * The files a `#alias/…` specifier maps to through the `imports` of the source's package and of
   * the root — Node's subpath imports: an exact key, or a key with one `*` whose match fills the
   * target's `*`. Every string in a conditional target is a candidate.
   */
  importTargets(spec: string, pkgDir: string | null): string[] {
    const out: string[] = [];
    for (const dir of new Set([pkgDir ?? this.root, this.root])) {
      const imports = this.manifest(dir)?.imports;
      if (typeof imports !== 'object' || imports === null) continue;
      for (const [key, value] of Object.entries(imports)) {
        const star = key.indexOf('*');
        let fill: string | null = null;
        if (star === -1) fill = key === spec ? '' : null;
        else {
          const pre = key.slice(0, star);
          const post = key.slice(star + 1);
          if (spec.length >= key.length - 1 && spec.startsWith(pre) && spec.endsWith(post))
            fill = spec.slice(pre.length, spec.length - post.length);
        }
        if (fill === null) continue;
        for (const target of stringLeaves(value))
          out.push(resolve(dir, star === -1 ? target : target.replaceAll('*', fill)));
      }
    }
    return out;
  }

  private workspaces(): string[] {
    this.workspaceDirs ??= this.project.pkg
      ? resolveWorkspaces(this.root, this.project.pkg).map((d) => join(this.root, d))
      : [];
    return this.workspaceDirs;
  }

  /** The workspace package a file lives in, or null at the root. */
  workspaceOf(abs: string): string | null {
    let best: string | null = null;
    for (const dir of this.workspaces())
      if (abs.startsWith(`${dir}/`) && (best === null || dir.length > best.length)) best = dir;
    return best;
  }

  /**
   * The package `bun --filter=<spec>` runs in, asked the way Bun asks: a `./` path names a
   * workspace directory, anything else is a workspace package's exact `name`. The root package is
   * never a match.
   */
  packageDir(spec: string): string | null {
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const dir = resolve(this.root, spec);
      return this.workspaces().includes(dir) ? dir : null;
    }
    if (this.workspaceNames === null) {
      this.workspaceNames = new Map();
      for (const dir of this.workspaces()) {
        const name = this.manifest(dir)?.name;
        if (typeof name === 'string' && !this.workspaceNames.has(name))
          this.workspaceNames.set(name, dir);
      }
    }
    return this.workspaceNames.get(spec) ?? null;
  }

  /**
   * A repo-relative file's text, read once — shared by the private rule and the identifier grep,
   * which read the same tracked files. Null for a symlink (git tracks its target on its own), an
   * unreadable or deleted file, and binary content.
   */
  text(rel: string): string | null {
    let hit = this.texts.get(rel);
    if (hit === undefined) {
      hit = null;
      try {
        const abs = join(this.root, rel);
        if (!lstatSync(abs).isSymbolicLink()) {
          const text = readFileSync(abs, 'utf8');
          if (!text.includes('\0')) hit = text;
        }
      } catch {
        /* deleted in the worktree, still in the index */
      }
      this.texts.set(rel, hit);
    }
    return hit;
  }

  /** What the identifier grep reads: the git index when there is one, and what it leaves out. */
  scopeCorpus(tracked: ReadonlySet<string> | null, exclude: (rel: string) => boolean): void {
    this.scope = { tracked, exclude };
    this.identWords = null;
  }

  /** How the identifier grep's corpus is described in a finding. */
  corpusName(): string {
    if (this.project.config.codeRoots) return 'occurs in no file under codeRoots';
    return this.scope?.tracked
      ? 'occurs in no tracked file outside the docs being checked'
      : 'occurs in no file outside the docs being checked';
  }

  /**
   * The files the identifier grep reads. By default every tracked file — an identifier lives in
   * `.env.example`, a shell hook or a CLI as readily as in `src/` — without a checkout the tree on
   * disk; configured `codeRoots` restrict it (to their tracked files, in a checkout). Always without
   * the docs being checked (every identifier would match itself), the working docs, binaries and
   * the `UNSCANNED` kinds.
   */
  corpusFiles(): string[] {
    const tracked = this.scope?.tracked ?? null;
    const exclude = this.scope?.exclude ?? ((): boolean => false);
    let files: Iterable<string>;
    const roots = this.project.config.codeRoots;
    if (roots) {
      const found = new Set<string>();
      for (const pattern of roots)
        for (const match of new Bun.Glob(pattern).scanSync({
          cwd: this.root,
          onlyFiles: false,
          dot: true
        })) {
          if (match.split('/').some((s) => SKIP_DIRS.has(s))) continue;
          let isDir = false;
          try {
            isDir = statSync(join(this.root, match)).isDirectory();
          } catch {
            continue;
          }
          if (isDir) for (const f of walkFiles(this.root, match)) found.add(f);
          else found.add(match);
        }
      files = tracked ? [...found].filter((f) => tracked.has(f)) : found;
    } else files = tracked ?? walkFiles(this.root, '');
    return [...files]
      .filter((p) => !BINARY.test(p) && !UNSCANNED.some(([re]) => re.test(p)) && !exclude(p))
      .sort();
  }

  /**
   * Every `UPPER_SNAKE_CASE` word in the corpus, so each identifier is one lookup instead of one
   * grep. The root `package.json` enters without its `udx` section: the allowlist quotes the
   * identifiers it exempts, and a grep that read it would find every exempted constant there.
   */
  identifiers(): Set<string> {
    if (this.identWords) return this.identWords;
    const words = new Set<string>();
    for (const p of this.corpusFiles()) {
      let text = this.text(p);
      if (text === null) continue;
      if (p === 'package.json' && this.project.pkg) {
        const { udx: _config, ...rest } = this.project.pkg;
        text = JSON.stringify(rest);
      }
      for (const m of text.matchAll(IDENT_WORD)) words.add(m[0]);
    }
    this.identWords = words;
    return words;
  }

  anchors(file: string): Set<string> {
    let hit = this.slugs.get(file);
    if (!hit) {
      hit = anchors(readFileSync(file, 'utf8'));
      this.slugs.set(file, hit);
    }
    return hit;
  }

  lineCount(file: string): number {
    let n = this.lines.get(file);
    if (n === undefined) {
      try {
        n = readFileSync(file, 'utf8').split('\n').length;
      } catch {
        n = 0; // unreadable — no number to disagree with
      }
      this.lines.set(file, n);
    }
    return n;
  }
}

export { gitIgnored, gitIgnoresContents };
