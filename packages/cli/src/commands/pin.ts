import { c } from '../lib/colors.ts';
import { detectContext } from '../lib/detect.ts';
import { log } from '../lib/log.ts';
import { readManifest, writeManifest } from '../lib/manifest.ts';

export interface PinFlags {
  cwd: string;
  dryRun: boolean;
  /** Paketname (positional[0]). */
  dep: string | undefined;
  /** Optionale Range (positional[1]); ohne Angabe wird die aktuelle aus der package.json gehalten. */
  range?: string;
}

/**
 * Hält eine devDep bewusst auf ihrer aktuellen (oder angegebenen) Range — `udx sync` zieht sie
 * danach nicht mehr auf den Pin hoch. Gegenstück zum sicheren Auto-Anheben: die Ausnahme für Deps,
 * die das Projekt absichtlich zurückhält.
 */
export function runPin(flags: PinFlags): number {
  if (!flags.dep) {
    log.err('Kein Paket angegeben — z. B. `udx pin @types/node`');
    return 2;
  }
  const ctx = detectContext(flags.cwd);
  const installed = { ...ctx.pkg.dependencies, ...ctx.pkg.devDependencies }[flags.dep];
  const range = flags.range ?? installed;
  if (!range) {
    log.err(`${flags.dep} ist nicht im Projekt — Range angeben: \`udx pin ${flags.dep} ^1.2.3\``);
    return 2;
  }

  const manifest = readManifest(flags.cwd);
  if (manifest.pinned[flags.dep] === range) {
    log.info(`${flags.dep} ist bereits gehalten bei ${range}.`);
    return 0;
  }
  manifest.pinned[flags.dep] = range;
  writeManifest(flags.cwd, manifest, flags.dryRun);
  log.ok(`${flags.dep} gehalten bei ${range}${flags.dryRun ? ' (Dry-Run)' : ''}.`);
  log.info(c.gray(`\`udx sync\` lässt es künftig unberührt. Lösen: \`udx unpin ${flags.dep}\``));
  return 0;
}

/** Hebt ein Halten wieder auf — der nächste `udx sync` zieht die Dep wieder auf den Pin. */
export function runUnpin(flags: PinFlags): number {
  if (!flags.dep) {
    log.err('Kein Paket angegeben — z. B. `udx unpin @types/node`');
    return 2;
  }
  const manifest = readManifest(flags.cwd);
  if (manifest.pinned[flags.dep] === undefined) {
    log.info(`${flags.dep} ist nicht gehalten.`);
    return 0;
  }
  delete manifest.pinned[flags.dep];
  writeManifest(flags.cwd, manifest, flags.dryRun);
  log.ok(`${flags.dep} nicht mehr gehalten${flags.dryRun ? ' (Dry-Run)' : ''}.`);
  log.info(c.gray('Der nächste `udx sync` zieht es wieder auf den vorgeschriebenen Pin.'));
  return 0;
}
