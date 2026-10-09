import { expect, test } from 'bun:test';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../..');

/** Lints through the real commitlint CLI with the repo's own config, which `createConfig` builds. */
function accepts(message: string): boolean {
  const { exitCode } = Bun.spawnSync(['bunx', '--bun', 'commitlint'], {
    cwd: REPO_ROOT,
    stdin: Buffer.from(message),
    stdout: 'ignore',
    stderr: 'ignore'
  });
  return exitCode === 0;
}

test('a subject may open with a capitalized (German) noun', () => {
  expect(accepts('feat: Rezepte importieren')).toBe(true);
  expect(accepts('fix(cli): Suche über alle Rezepte')).toBe(true);
  expect(accepts('feat: rezepte importieren')).toBe(true);
});

test('the rest of config-conventional still applies', () => {
  expect(accepts('Feat: x')).toBe(false);
  expect(accepts('feat x')).toBe(false);
});
