import { c } from './colors.ts';

export interface DiffOptions {
  /** Context lines around each change (default 3). */
  context?: number;
  /** ANSI colors (default true). */
  color?: boolean;
}

interface Op {
  t: 'eq' | 'del' | 'add';
  a: number;
  b: number;
  line: string;
}

/** Trailing newline — as a top-level regex, since `splitLines` runs often per diff. */
const TRAILING_NEWLINE = /\n$/;

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(TRAILING_NEWLINE, '').split('\n');
}

/**
 * Line-wise LCS diff (DP backtrack). For config files (small) entirely sufficient
 * and zero-dep. Returns a flat op sequence (eq/del/add) with a-/b-line indices.
 */
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = length of the LCS of a[i:] and b[j:].
  const dp: number[][] = [];
  for (let i = 0; i <= n; i++) dp.push(new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as number[];
    const next = dp[i + 1] as number[];
    const ai = a[i] as string;
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        ai === (b[j] as string) ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] as string;
    const bj = b[j] as string;
    if (ai === bj) {
      ops.push({ t: 'eq', a: i, b: j, line: ai });
      i++;
      j++;
    } else {
      // On a tie, prefer deletion ⇒ stable, deterministic hunks.
      const keepDel = ((dp[i + 1] as number[])[j] ?? 0) >= ((dp[i] as number[])[j + 1] ?? 0);
      if (keepDel) {
        ops.push({ t: 'del', a: i, b: j, line: ai });
        i++;
      } else {
        ops.push({ t: 'add', a: i, b: j, line: bj });
        j++;
      }
    }
  }
  while (i < n) ops.push({ t: 'del', a: i, b: j, line: a[i++] as string });
  while (j < m) ops.push({ t: 'add', a: i, b: j, line: b[j++] as string });
  return ops;
}

/**
 * Renders a unified-style diff from `oldText` → `newText` (colored, ready-to-indent).
 * Empty string if identical. Only changed regions, plus their context lines, appear.
 */
export function formatDiff(oldText: string, newText: string, opts: DiffOptions = {}): string {
  const context = opts.context ?? 3;
  const color = opts.color ?? true;
  const ops = diffOps(splitLines(oldText), splitLines(newText));
  if (ops.every((o) => o.t === 'eq')) return '';

  // Visible: every change plus `context` lines around it.
  const visible = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if ((ops[k] as Op).t === 'eq') continue;
    const lo = Math.max(0, k - context);
    const hi = Math.min(ops.length - 1, k + context);
    for (let p = lo; p <= hi; p++) visible[p] = true;
  }

  const paint = (s: string, fn: (x: string) => string): string => (color ? fn(s) : s);
  const out: string[] = [];
  let k = 0;
  while (k < ops.length) {
    if (!visible[k]) {
      k++;
      continue;
    }
    let end = k;
    while (end < ops.length && visible[end]) end++;
    const hunk = ops.slice(k, end);
    const aLen = hunk.filter((o) => o.t !== 'add').length;
    const bLen = hunk.filter((o) => o.t !== 'del').length;
    const head = hunk[0] as Op;
    out.push(paint(`@@ -${head.a + 1},${aLen} +${head.b + 1},${bLen} @@`, c.cyan));
    for (const o of hunk) {
      if (o.t === 'del') out.push(paint(`- ${o.line}`, c.red));
      else if (o.t === 'add') out.push(paint(`+ ${o.line}`, c.green));
      else out.push(paint(`  ${o.line}`, c.gray));
    }
    k = end;
  }
  return out.join('\n');
}
