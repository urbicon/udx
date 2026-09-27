import { isAbsolute } from 'node:path';

/** Runs git in `root`; null when there is no git binary at all. */
export function runGit(
  root: string,
  args: string[],
  stdin?: string
): { code: number; stdout: string } | null {
  try {
    const proc = Bun.spawnSync(['git', '-C', root, ...args], {
      ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }),
      stdout: 'pipe',
      stderr: 'pipe'
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString() };
  } catch {
    return null;
  }
}

/**
 * Asks git, so the ignore rules live in `.gitignore` and not in a second list. A path outside the
 * repo makes git reject the whole batch, so only repo-relative ones are asked.
 */
export function gitIgnored(root: string, paths: Iterable<string>): Set<string> {
  const ask = [...new Set(paths)].filter((p) => p !== '' && !p.startsWith('../') && !isAbsolute(p));
  if (ask.length === 0) return new Set();
  const r = runGit(root, ['check-ignore', '--stdin'], `${ask.join('\n')}\n`);
  // 0 = some ignored, 1 = none. Anything else (no repo, no git) answers nothing.
  if (r === null || (r.code !== 0 && r.code !== 1)) return new Set();
  return new Set(r.stdout.split('\n').filter(Boolean));
}

/** A file that never exists, asked about in place of the folder it would sit in. */
const PROBE = '__udx_probe__.md';

/**
 * Whether git ignores what goes into `dir` — asked of a Markdown file inside it, not of the folder:
 * `dir/*` and `dir/**` ignore the contents but not the folder, and `dir/` is only recognised as a
 * folder once it exists on disk, which in CI it does not. False outside a checkout.
 */
export function gitIgnoresContents(root: string, dir: string): boolean {
  const probe = `${dir}/${PROBE}`;
  return gitIgnored(root, [probe]).has(probe);
}
