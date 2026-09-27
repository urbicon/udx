import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { PackageJson } from '../detect.ts';
import { exists, readText } from '../fs.ts';

/** The check cannot answer (malformed config or argument, unreadable index) — exit 2, never a clean run. */
export class DocsCheckError extends Error {}

export interface PrivateDir {
  /** Repo-relative, always ending in `/`. */
  dir: string;
  why: string | null;
}

export interface AllowEntry {
  text: string;
  why: string;
}

export interface DocsConfig {
  /** Repo-relative path of the instruction index, spelled as the directory lists it; null when there is none. */
  index: string | null;
  budget: number | null;
  sources: string[];
  /** Globs the identifier grep is restricted to; null reads every tracked file (see `corpusFiles`). */
  codeRoots: string[] | null;
  /** Repo-relative, without a trailing `/`. */
  workingDocs: string;
  /**
   * The configured private folders. The working-docs folder joins them when git ignores it —
   * git's answer, asked by the check, never a setting.
   */
  privateDirs: PrivateDir[];
  /** Repo-relative path of the Markdown tracker file; null when the tracker is the issue tracker. */
  tracker: string | null;
  allowlist: AllowEntry[];
}

export interface Project {
  /** Root `package.json`, parsed; null when the root has none. */
  pkg: PackageJson | null;
  pkgText: string | null;
  config: DocsConfig;
}

/** The index itself is prepended when there is one. */
export const DEFAULT_SOURCES: readonly string[] = [
  'CLAUDE.md',
  'README.md',
  'docs/**/*.md',
  '.claude/skills/**/*.md',
  'packages/*/README.md',
  'packages/*/docs/**/*.md',
  'apps/*/README.md'
];

const KEYS = [
  'index',
  'budget',
  'sources',
  'codeRoots',
  'workingDocs',
  'privateDirs',
  'tracker',
  'allowlist'
] as const;

const DOT_SLASH = /^(?:\.\/)+/;
const TRAILING_SLASHES = /\/+$/;

/** The working-docs folder when `udx.docs.workingDocs` is unset. */
export const DEFAULT_WORKING_DOCS = 'docs/internal';

/** A repo path as the config spells it, without leading `./` or trailing slashes. */
export function normalizeRepoPath(value: string): string {
  return value.trim().replace(DOT_SLASH, '').replace(TRAILING_SLASHES, '');
}
const PARENT_SEGMENT = /(^|\/)\.\.(\/|$)/;

const fail = (message: string): DocsCheckError => new DocsCheckError(`package.json: ${message}`);

function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A repo-relative path or glob: no absolute path and no `..`, which would reach outside the repo. */
function repoPath(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw fail(`udx.docs.${key} must be a non-empty string (got ${shown(value)})`);
  const path = normalizeRepoPath(value);
  if (path === '' || isAbsolute(path) || PARENT_SEGMENT.test(path))
    throw fail(`udx.docs.${key} must be a path inside the repo (got ${shown(value)})`);
  return path;
}

function globList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw fail(`udx.docs.${key} must be a non-empty array of globs (got ${shown(value)})`);
  return value.map((item, i) => repoPath(item, `${key}[${i}]`));
}

function pair(value: unknown): [string, string] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [a, b] = value as unknown[];
  if (typeof a !== 'string' || typeof b !== 'string' || a.trim() === '' || b.trim() === '')
    return null;
  return [a, b.trim()];
}

/**
 * Whether `rel` exists spelled exactly so. `existsSync` answers case-insensitively on macOS and
 * case-sensitively on Linux, and CI runs on Linux: the listing is the answer both agree on.
 */
export function existsExact(root: string, rel: string): boolean {
  let dir = root;
  for (const segment of rel.split('/')) {
    try {
      if (!readdirSync(dir).includes(segment)) return false;
    } catch {
      return false;
    }
    dir = join(dir, segment);
  }
  return exists(dir);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `AGENTS.md` in any case (read from the listing, so the spelling is the real one), else `CLAUDE.md`. */
function defaultIndex(root: string): string | null {
  const names = readdirSync(root).sort();
  const agents = names.filter((n) => n.toLowerCase() === 'agents.md' && isFile(join(root, n)));
  const pick = agents.includes('AGENTS.md') ? 'AGENTS.md' : agents[0];
  if (pick) return pick;
  return names.includes('CLAUDE.md') && isFile(join(root, 'CLAUDE.md')) ? 'CLAUDE.md' : null;
}

/** Reads the root `package.json` and its `udx.docs` section. Every key is optional; a malformed one is an error. */
export function loadProject(root: string): Project {
  const file = join(root, 'package.json');
  let pkg: PackageJson | null = null;
  let pkgText: string | null = null;
  if (exists(file)) {
    pkgText = readText(file);
    try {
      pkg = JSON.parse(pkgText) as PackageJson;
    } catch (error) {
      throw new DocsCheckError(
        `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!isObject(pkg)) throw new DocsCheckError('package.json must hold an object');
  }

  let raw: Record<string, unknown> = {};
  const udx = pkg?.udx;
  if (udx !== undefined) {
    if (!isObject(udx)) throw fail(`udx must be an object (got ${shown(udx)})`);
    if (udx.docs !== undefined) {
      if (!isObject(udx.docs)) throw fail(`udx.docs must be an object (got ${shown(udx.docs)})`);
      raw = udx.docs;
    }
  }
  for (const key of Object.keys(raw))
    if (!(KEYS as readonly string[]).includes(key))
      throw fail(`udx.docs.${key} is not a setting (known: ${KEYS.join(', ')})`);

  let index: string | null;
  if (raw.index === undefined) index = defaultIndex(root);
  else {
    index = repoPath(raw.index, 'index');
    if (!existsExact(root, index) || !isFile(join(root, index)))
      throw fail(`udx.docs.index names ${index}, which is not a file here (spelled exactly so)`);
  }

  let budget: number | null = null;
  if (raw.budget !== undefined) {
    if (typeof raw.budget !== 'number' || !Number.isInteger(raw.budget) || raw.budget <= 0)
      throw fail(`udx.docs.budget must be a positive integer (got ${shown(raw.budget)})`);
    if (index === null)
      throw fail('udx.docs.budget is set, but there is no index file (AGENTS.md or CLAUDE.md)');
    budget = raw.budget;
  }

  const workingDocs =
    raw.workingDocs === undefined ? DEFAULT_WORKING_DOCS : repoPath(raw.workingDocs, 'workingDocs');

  const privateDirs: PrivateDir[] = [];
  if (raw.privateDirs !== undefined) {
    if (!Array.isArray(raw.privateDirs))
      throw fail(`udx.docs.privateDirs must be an array (got ${shown(raw.privateDirs)})`);
    raw.privateDirs.forEach((item, i) => {
      const key = `privateDirs[${i}]`;
      let entry: PrivateDir;
      if (typeof item === 'string') entry = { dir: `${repoPath(item, key)}/`, why: null };
      else {
        const p = pair(item);
        if (!p)
          throw fail(`udx.docs.${key} must be "dir" or ["dir", "reason"] (got ${shown(item)})`);
        entry = { dir: `${repoPath(p[0], key)}/`, why: p[1] };
      }
      const known = privateDirs.find((d) => d.dir === entry.dir);
      if (known) known.why = entry.why ?? known.why;
      else privateDirs.push(entry);
    });
  }

  let tracker: string | null = null;
  if (raw.tracker !== undefined && raw.tracker !== 'issues') {
    const path = typeof raw.tracker === 'string' ? repoPath(raw.tracker, 'tracker') : '';
    if (!path.endsWith('.md'))
      throw fail(
        `udx.docs.tracker must be "issues" or the path of a Markdown file (got ${shown(raw.tracker)})`
      );
    tracker = path;
  }

  const allowlist: AllowEntry[] = [];
  if (raw.allowlist !== undefined) {
    if (!Array.isArray(raw.allowlist))
      throw fail(`udx.docs.allowlist must be an array (got ${shown(raw.allowlist)})`);
    raw.allowlist.forEach((item, i) => {
      const p = pair(item);
      if (!p)
        throw fail(`udx.docs.allowlist[${i}] must be ["text", "reason"] (got ${shown(item)})`);
      if (allowlist.some((e) => e.text === p[0]))
        throw fail(`udx.docs.allowlist[${i}] repeats ${shown(p[0])}`);
      allowlist.push({ text: p[0], why: p[1] });
    });
  }

  const sources =
    raw.sources === undefined
      ? [...(index ? [index] : []), ...DEFAULT_SOURCES]
      : globList(raw.sources, 'sources');
  const codeRoots = raw.codeRoots === undefined ? null : globList(raw.codeRoots, 'codeRoots');

  return {
    pkg,
    pkgText,
    config: { index, budget, sources, codeRoots, workingDocs, privateDirs, tracker, allowlist }
  };
}
