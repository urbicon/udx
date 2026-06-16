import { c } from '../lib/colors.ts';
import { detectContext } from '../lib/detect.ts';
import { log } from '../lib/log.ts';
import { readManifest, writeManifest } from '../lib/manifest.ts';

export interface PinFlags {
  cwd: string;
  dryRun: boolean;
  /** Package name (positional[0]). */
  dep: string | undefined;
  /** Optional range (positional[1]); without one the current range from package.json is pinned. */
  range?: string;
}

/**
 * Pins a devDep deliberately at its current (or given) range — `udx sync` no longer bumps it to
 * the pin afterwards. The counterpart to safe auto-bumping: the exception for deps that the
 * project intentionally holds back.
 */
export function runPin(flags: PinFlags): number {
  if (!flags.dep) {
    log.err('No package given — e.g. `udx pin @types/node`');
    return 2;
  }
  const ctx = detectContext(flags.cwd);
  const installed = { ...ctx.pkg.dependencies, ...ctx.pkg.devDependencies }[flags.dep];
  const range = flags.range ?? installed;
  if (!range) {
    log.err(`${flags.dep} is not in the project — give a range: \`udx pin ${flags.dep} ^1.2.3\``);
    return 2;
  }

  const manifest = readManifest(flags.cwd);
  if (manifest.pinned[flags.dep] === range) {
    log.info(`${flags.dep} is already pinned at ${range}.`);
    return 0;
  }
  manifest.pinned[flags.dep] = range;
  writeManifest(flags.cwd, manifest, flags.dryRun);
  log.ok(`${flags.dep} pinned at ${range}${flags.dryRun ? ' (dry run)' : ''}.`);
  log.info(
    c.gray(`\`udx sync\` leaves it untouched from now on. Release: \`udx unpin ${flags.dep}\``)
  );
  return 0;
}

/** Releases a pin again — the next `udx sync` bumps the dep back to the pin. */
export function runUnpin(flags: PinFlags): number {
  if (!flags.dep) {
    log.err('No package given — e.g. `udx unpin @types/node`');
    return 2;
  }
  const manifest = readManifest(flags.cwd);
  if (manifest.pinned[flags.dep] === undefined) {
    log.info(`${flags.dep} is not pinned.`);
    return 0;
  }
  delete manifest.pinned[flags.dep];
  writeManifest(flags.cwd, manifest, flags.dryRun);
  log.ok(`${flags.dep} no longer pinned${flags.dryRun ? ' (dry run)' : ''}.`);
  log.info(c.gray('The next `udx sync` bumps it back to the prescribed pin.'));
  return 0;
}
