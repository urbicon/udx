import { c } from '../lib/colors.ts';

/**
 * Full `--help` output. The version comes in as a parameter (instead of importing package.json
 * here), so the help is side-effect-free and version-stable for snapshotting in tests.
 *
 * Naming (D7): the dev-facing commands are `init·status·sync·add·remove` (+ `pin/unpin`);
 * `adopt`/`skip`/`doctor` are kept as aliases but only appear in the footnote, not in the
 * command table.
 */
export function helpText(version: string): string {
  return `${c.bold('udx')} — urbicon development harness  ${c.gray(`v${version}`)}

${c.bold('Usage')}
  udx <command> [options]

${c.bold('Commands')}
  init           Set up the harness in a project (configs, hooks, scripts, devDeps)
  status         Current state: what's there, what a sync would change and how (default without a command)
  sync           Update managed files & devDeps (pull in improvements)
  add <id>       Adopt a building block and set it up directly (e.g. git-hooks, knowledge)
  remove <id>    Stop managing a building block (existing files stay)
  pin <dep> [r]  Deliberately pin a devDep version — \`sync\` won't bump it
  unpin <dep>    Release a pin again
  docs check     Check the docs: references resolve, the knowledge layer holds (exit 1 on findings)

${c.bold('Options')}
  -n, --dry-run     write nothing, only show
  -f, --force       also overwrite locally modified files & package.json drift
  -i, --interactive decide per file on conflicts (update/skip/diff)
      --install     run \`bun install\` right after init/sync/add when there are new devDeps
      --only <ids>  only these building blocks (block or file ids, comma-separated)
      --diff        on drift, show the difference local → target
      --json        (status, docs check) structured output for tooling
      --svelte      force Svelte setup (instead of auto-detection)
      --no-svelte   force a plain TS setup
      --cwd <path>  target directory (default: current; alias --root)
  -h, --help        this help
  -V, --version     version

${c.bold('Examples')}
  udx                       ${c.gray('# status: what is there, what a sync would change')}
  udx init                  ${c.gray('# set up a new/existing project')}
  udx sync --dry-run --diff ${c.gray('# preview with diff of what an update would change')}
  udx add git-hooks         ${c.gray('# adopt lefthook and set it up')}
  udx add knowledge         ${c.gray('# opt-in: the knowledge-layer skill + docs:check')}
  udx remove git-hooks      ${c.gray('# stop managing lefthook (your own hook stack)')}

${c.gray('Aliases  doctor — status with exit code for CI · adopt/skip — only adopt/decline (add also sets up)')}
`;
}
