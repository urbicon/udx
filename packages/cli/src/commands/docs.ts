import { check, type Report } from '../lib/docs-check/check.ts';
import { formatReport } from '../lib/docs-check/report.ts';
import { log } from '../lib/log.ts';

export interface DocsFlags {
  /** The project root to check. */
  root: string;
  json: boolean;
  /** Positionals after the subcommand — none are taken. */
  extra: string[];
}

const SUBCOMMANDS = ['check'];

/**
 * `udx docs <sub>`. Exit 1 means findings and nothing else: a check that could not answer — a
 * malformed config, an unreadable index, an unexpected error — exits 2, so no failure of the
 * check itself reads as a verdict on the docs.
 */
export function runDocs(sub: string | undefined, flags: DocsFlags): number {
  if (sub === undefined || !SUBCOMMANDS.includes(sub)) {
    log.err(
      sub === undefined
        ? `docs needs a subcommand (${SUBCOMMANDS.join(', ')}), e.g. \`udx docs check\``
        : `Unknown docs subcommand: ${sub} (known: ${SUBCOMMANDS.join(', ')})`
    );
    return 2;
  }
  if (flags.extra.length > 0) {
    log.err(`docs check takes no arguments (got ${flags.extra.join(' ')}); use --root <dir>`);
    return 2;
  }
  let report: Report;
  try {
    report = check(flags.root);
  } catch (err) {
    log.err(`docs check: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  log.plain(flags.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.findings.length > 0 ? 1 : 0;
}
