import { isAbsolute } from 'node:path';

/** A pattern or a placeholder is not a claim that a file exists. */
export const PATTERN_CHARS = /[*<>{}…$?|]/;
/** As `PATTERN_CHARS`, plus `→` and `...`, because prose points with them (rule `private`). */
export const PLACEHOLDER = /[*<>{}…$?|→]|\.\.\./;
export const IDENT = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
export const FILE_LINE = /^(.+?):(\d+)(?:-(\d+))?$/;
export const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
export const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|ogg|pdf|zip|gz|tgz|bz2|xz|7z|jar|wasm|svg|lock|lockb|sqlite|db)$/i;
export const OPEN_CHECKBOX = /^\s*[-*+] \[ \]/;
/** Matched case-insensitively against a working doc's first `HEAD_LINES` lines. */
const END_CONDITION =
  /ends when|end condition|endbedingung|endet,? wenn|lebt,? (?:bis|solange)|permanent|dauerhaft/gi;
/** A marker right behind one of these says the opposite of what it says. */
const NEGATED = /\b(?:not|nicht|kein\w*)\s+$/i;
export const HEAD_LINES = 20;
export const ARCHIVE_DIR = /^_?archive[sd]?$/i;
/** Bun's flags that take a value, when it is not written as `--flag=value`. */
const VALUE_FLAGS = new Set([
  '--filter',
  '-F',
  '--cwd',
  '--env-file',
  '--config',
  '-c',
  '--preload',
  '-r',
  '--require',
  '--elide-lines',
  '--shell'
]);
const ALL_WORKSPACES = new Set(['--workspaces', '--ws']);
const QUOTES = /^['"]+|['"]+$/g;
const NAME_TAIL = /[),;]+$/;
export const SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/;
/** An `UPPER_SNAKE_CASE` word, bounded exactly as `\bNAME\b` would be. */
export const IDENT_WORD = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
export const MAIL_OR_TEL = /^(mailto|tel):/;
export const WEB_URL = /^https?:\/\//;
export const PKG_BASE = /^(src|scripts|docs)\//;
export const LEADING_UP = /^(?:\.{1,2}\/)+/;
/** A first segment shaped like a public host name. */
export const HOST_HEAD = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev)\//;

/**
 * Tracked files neither the private rule nor the identifier grep reads, one reason each. A pattern
 * names a kind of file rather than suppressing a finding, so unlike the allowlist it has no stale
 * state to report.
 */
export const UNSCANNED: ReadonlyArray<readonly [pattern: RegExp, why: string]> = [
  [/(^|\/)CHANGELOG\.md$/, 'generated from commit messages, never edited by hand'],
  [/(^|\/)\.gitignore$/, 'the ignore rules name the private directories to keep them out'],
  [
    /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/,
    'a lockfile, not prose'
  ]
];

const ARTIFACT = /(^|\/)(node_modules|dist|\.svelte-kit)(\/|$)/;
/** A fence opens with three or more of one character; a backtick fence's info string has none. */
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
/** An inline link: a `<…>` or a bare target, then an optional `"…"`, `'…'` or `(…)` title. */
const LINK =
  /\[([^\]]*)\]\(\s*(?:<([^>\n]*)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
/** A reference definition (`[ref]: docs/x.md "title"`); a footnote (`[^1]:`) is none. */
const REF_DEF = /^\s{0,3}\[([^\]^][^\]]*)\]:\s*<?(\S+?)>?(?:\s|$)/;
const SPAN = /`([^`\n]+)`/g;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const SETEXT = /^ {0,3}(?:=+|-+)\s*$/;
/** A line that cannot be a setext heading's text: blank, a heading, a list item, a quote, a table, HTML. */
const NOT_PARAGRAPH = /^\s*(?:$|#|[-*+]\s|\d+[.)]\s|>|\||<)/;
const HTML_ANCHOR = /<[A-Za-z][^>]*?\s(?:id|name)\s*=\s*["']([^"']+)["']/g;
const FRONTMATTER_END = /^(?:---|\.\.\.)\s*$/;
const TAG = /<[^>]*>/g;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const EMPHASIS = /[*~]/g;
const NON_SLUG = /[^\p{L}\p{N}\p{M}\s_-]/gu;
const WHITESPACE = /\s/g;
const LEAD_PUNCT = /^[('"`[\]]+/;
const TRAIL_PUNCT = /[)'"`\],;]+$/;
const TRAIL_DOT = /\.$/;
const LEAD_DOT_SLASH = /^\.\//;
const PATH_WITH_EXT = /\/[^/]*\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const REGEX_SPECIAL = /[.*+?^$|()[\]{}\\/]/g;
const SENTENCE_END = /[.,;:!?]+$/;
const WORDS = /\s+/;
const STRING_ESCAPES = /(?:\\[nrt])+$/;
const FRAGMENT = /#.*$/;
const LINE_SUFFIX = /:\d+(?:-\d+)?(?::\d+)?$/;
const REPO_HTTP =
  /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const REPO_SCP = /^[^@\s]+@([^:/\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?$/;
const REPO_SHORT = /^(?:(github|gitlab|bitbucket):)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;
const SHORT_HOST: Record<string, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org'
};

/**
 * Numbered lines outside fenced blocks: a fence is an example, not a reference. As CommonMark
 * reads it: a fence closes only on the character it opened with, at least as many times, and
 * nothing after it — so a ```` ```` ```` block can show a ``` ``` ``` one.
 */
export function* proseLines(text: string): Generator<[line: number, text: string]> {
  let open: string | null = null;
  for (const [i, line] of text.split('\n').entries()) {
    const m = line.match(FENCE);
    const run = m?.[1] ?? '';
    const rest = m?.[2] ?? '';
    if (open === null) {
      if (m && !(run[0] === '`' && rest.includes('`'))) open = run;
      else yield [i + 1, line];
    } else if (m && run[0] === open[0] && run.length >= open.length && rest.trim() === '')
      open = null;
  }
}

/**
 * A line's link targets and inline code spans. A span inside a link's label is left out: the
 * target is the claim, the label only names it — and for a doc that ships elsewhere, names it the
 * way it is read there.
 */
export function lineRefs(line: string): { links: string[]; spans: string[] } {
  const labels: Array<[number, number]> = [];
  const links: string[] = [];
  const def = line.match(REF_DEF);
  if (def?.[2]) links.push(def[2]);
  for (const m of line.matchAll(LINK)) {
    labels.push([m.index + 1, m.index + 1 + (m[1]?.length ?? 0)]);
    links.push(m[2] ?? m[3] ?? '');
  }
  const spans: string[] = [];
  for (const m of line.matchAll(SPAN)) {
    if (labels.some(([from, to]) => m.index >= from && m.index + m[0].length <= to)) continue;
    spans.push(m[1] ?? '');
  }
  return { links, spans };
}

/**
 * The anchors a document has, lowercased: GitHub's heading slugs (ATX and setext headings, repeats
 * numbered `-1`, `-2` …) and every `id`/`name` attribute of its HTML, fenced ones excluded. A YAML
 * front matter is skipped, or its closing `---` would read as a setext underline.
 */
export function anchors(text: string): Set<string> {
  const out = new Set<string>();
  const counts = new Map<string, number>();
  const heading = (raw: string): void => {
    const base = slugify(raw);
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  };
  const lines = text.split('\n');
  let front = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && FRONTMATTER_END.test(l));
    if (end > 0) front = end + 1;
  }
  let prev: [number, string] | null = null;
  for (const [n, line] of proseLines(text)) {
    if (n <= front) continue;
    for (const m of line.matchAll(HTML_ANCHOR)) out.add((m[1] ?? '').toLowerCase());
    const atx = line.match(HEADING);
    if (atx) heading(atx[1] ?? '');
    else if (
      SETEXT.test(line) &&
      prev?.[0] === n - 1 &&
      !NOT_PARAGRAPH.test(prev[1]) &&
      !SETEXT.test(prev[1])
    )
      heading(prev[1].trim());
    prev = [n, line];
  }
  return out;
}

/** `decodeURIComponent`, or the input where it is no valid encoding. */
export function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Whether a working doc's head names its end condition. A marker right behind a negation ("not
 * permanent", "nicht dauerhaft", "keine Endbedingung") says the opposite and does not count.
 */
export function namesEndCondition(head: string): boolean {
  for (const m of head.matchAll(END_CONDITION))
    if (!NEGATED.test(head.slice(0, m.index))) return true;
  return false;
}

export interface ScriptRef {
  name: string;
  /** `--filter`/`-F` value, as written. */
  filter: string | null;
  /** `--cwd` value, as written. */
  cwd: string | null;
}

/**
 * The scripts a span runs through `bun run`, with the flags Bun reads on either side of `run`:
 * `--filter`/`-F` and `--cwd` pick the package, `--bun` and the other flags are skipped (with their
 * value, where Bun takes one). A script name never starts with `-`. `--workspaces` runs in every
 * package and names no single one, so it yields nothing.
 */
export function scriptRefs(span: string): ScriptRef[] {
  const tokens = span.split(WORDS).filter(Boolean);
  const out: ScriptRef[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'bun') continue;
    let filter: string | null = null;
    let cwd: string | null = null;
    let all = false;
    let run = false;
    let name: string | null = null;
    let j = i + 1;
    for (; j < tokens.length; j++) {
      const t = (tokens[j] ?? '').replace(QUOTES, '');
      if (t.startsWith('-')) {
        const eq = t.indexOf('=');
        let flag = eq === -1 ? t : t.slice(0, eq);
        let value: string | null = eq === -1 ? null : t.slice(eq + 1).replace(QUOTES, '');
        if (flag.startsWith('-F') && flag.length > 2 && !flag.startsWith('--')) {
          value = flag.slice(2);
          flag = '-F';
        }
        if (value === null && VALUE_FLAGS.has(flag))
          value = (tokens[++j] ?? '').replace(QUOTES, '');
        if (flag === '--filter' || flag === '-F') filter = value;
        else if (flag === '--cwd') cwd = value;
        else if (ALL_WORKSPACES.has(flag)) all = true;
        continue;
      }
      if (!run) {
        if (t !== 'run') break;
        run = true;
        continue;
      }
      name = t.replace(NAME_TAIL, '');
      break;
    }
    if (run && name && !all) out.push({ name, filter, cwd });
    i = j;
  }
  return out;
}

/** Drops `<…>` runs until none is left, so a nested `<<b>>` cannot survive one pass. */
function stripTags(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(TAG, '');
    if (next === out) return out;
    out = next;
  }
}

/**
 * GitHub's heading slug: lowercase, punctuation dropped except `-`/`_`, spaces → `-`. Inside inline
 * code nothing is HTML, so a heading naming `<Widget>` keeps those letters — strip the angle brackets
 * there and the anchor the document actually links to reads as broken.
 */
export function slugify(raw: string): string {
  return raw
    .split('`')
    .map((part, i) => (i % 2 === 1 ? part : stripTags(part)))
    .join('')
    .replace(MD_LINK, '$1')
    .replace(EMPHASIS, '')
    .trim()
    .toLowerCase()
    .replace(NON_SLUG, '')
    .replace(WHITESPACE, '-');
}

export function normalize(token: string): string {
  return token
    .replace(LEAD_PUNCT, '')
    .replace(TRAIL_PUNCT, '')
    .replace(TRAIL_DOT, '')
    .replace(LEAD_DOT_SLASH, '');
}

/** Only a span carrying a `/` and ending in `/` or an alphabetic extension claims a path. */
export function looksLikePath(t: string): boolean {
  return t.includes('/') && (t.endsWith('/') || PATH_WITH_EXT.test(t));
}

export function skippable(t: string): boolean {
  return (
    t === '' ||
    PATTERN_CHARS.test(t) ||
    t.includes('...') ||
    t.includes('://') ||
    t.startsWith('~') ||
    t.startsWith('@') ||
    isAbsolute(t) ||
    // A build artifact is absent by design; the answer must not turn on whether a build ran first.
    ARTIFACT.test(t)
  );
}

export function splitFragment(target: string): [path: string, fragment: string | null] {
  const i = target.indexOf('#');
  return i === -1 ? [target, null] : [target.slice(0, i), target.slice(i + 1)];
}

/**
 * A token starting with one of `dirs`, optionally behind `./` or `../`: group 1 the token, group 2
 * the directory. The lookbehind keeps a longer path (`apps/docs/internal/…`) and a URL out; the
 * token runs to whitespace, a quote or a bracket, and what it may not be is `privateTarget`'s call.
 */
export function privatePointer(dirs: readonly string[]): RegExp {
  const alternatives = [...dirs]
    .sort((a, b) => b.length - a.length)
    .map((d) => d.replace(REGEX_SPECIAL, '\\$&'))
    .join('|');
  return new RegExp(`(?<![\\w./-])(?:\\.{1,2}/)*((${alternatives})[^\\s\`'"()<>[\\]{},;|]*)`, 'g');
}

/**
 * The path a private-pointer token names, or null when it names none: a string escape (`\n`) the
 * token ran into, sentence punctuation, a `#anchor` and a `:line` suffix come off first, so a pointer into a tracked file is looked up as
 * that file. The bare directory, a placeholder (`docs/internal/…`, `$FILE`) and a compound written
 * onto the folder name (`docs/internal/-Dokumente`) are not pointers.
 */
export function privateTarget(token: string, dir: string): string | null {
  const target = token
    .replace(STRING_ESCAPES, '')
    .replace(SENTENCE_END, '')
    .replace(FRAGMENT, '')
    .replace(LINE_SUFFIX, '');
  const below = target.slice(dir.length);
  if (below === '' || below.startsWith('-') || PLACEHOLDER.test(target)) return null;
  return target;
}

/**
 * The prefix under which a link into this repo's own web view names a repo file — derived from
 * `package.json` `repository`, so a moved repo moves the prefix with it. Null without one.
 */
export function repoBlobLink(repository: unknown): RegExp | null {
  const raw =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' && repository !== null
        ? (repository as { url?: unknown }).url
        : undefined;
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  const m = url.match(REPO_HTTP) ?? url.match(REPO_SCP);
  let host: string | undefined;
  let owner: string | undefined;
  let name: string | undefined;
  if (m) [, host, owner, name] = m;
  else {
    const s = url.match(REPO_SHORT);
    if (!s) return null;
    host = SHORT_HOST[s[1] ?? 'github'];
    [, , owner, name] = s;
  }
  if (!host || !owner || !name) return null;
  const esc = (s: string): string => s.replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(
    `^https://${esc(host)}/${esc(owner)}/${esc(name)}/(?:-/)?(?:blob|tree)/(?:main|master|HEAD)/(.+)$`
  );
}
