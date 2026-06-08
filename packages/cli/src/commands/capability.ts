import { CAPABILITIES, findCapability } from '../lib/capabilities.ts';
import { c } from '../lib/colors.ts';
import { log } from '../lib/log.ts';
import { readManifest, writeManifest } from '../lib/manifest.ts';
import { type HarnessFlags, runHarness } from './harness.ts';

export interface CapabilityFlags {
  cwd: string;
  dryRun: boolean;
  capability: string | undefined;
}

export interface AddFlags extends HarnessFlags {
  capability: string | undefined;
}

function listCapabilities(): void {
  log.info('Bekannte Bausteine:');
  for (const cap of CAPABILITIES) log.info(`  ${c.cyan(cap.id)} — ${cap.label}`);
}

/** Schließt den Baustein-Namen aus den Flags auf; meldet & listet bei Fehlern. */
function resolve(flags: CapabilityFlags, verb: string) {
  if (!flags.capability) {
    log.err(`Kein Baustein angegeben — z. B. \`udx ${verb} git-hooks\``);
    listCapabilities();
    return undefined;
  }
  const cap = findCapability(flags.capability);
  if (!cap) {
    log.err(`Unbekannter Baustein: ${flags.capability}`);
    listCapabilities();
  }
  return cap;
}

/** Wählt einen Baustein dauerhaft ab — init/sync/doctor überspringen ihn künftig. */
export function runSkip(flags: CapabilityFlags): number {
  const cap = resolve(flags, 'skip');
  if (!cap) return 2;

  const manifest = readManifest(flags.cwd);
  const alreadyManual =
    manifest.declined[cap.id] === 'manual' && !manifest.adopted.includes(cap.id);
  if (alreadyManual) {
    log.info(`${cap.label} ist bereits abgewählt.`);
    return 0;
  }
  manifest.adopted = manifest.adopted.filter((id) => id !== cap.id);
  manifest.declined[cap.id] = 'manual';
  writeManifest(flags.cwd, manifest, flags.dryRun);
  log.ok(`${cap.label} abgewählt${flags.dryRun ? ' (Dry-Run)' : ''}.`);
  log.info(c.gray(`Vorhandene Dateien bleiben. Rückgängig: \`udx add ${cap.id}\``));
  return 0;
}

/**
 * Nimmt einen Baustein explizit auf (überstimmt die Auto-Abwahl, z. B. lefthook trotz husky)
 * und entfernt eine vorhandene Abwahl. `udx sync` richtet ihn anschließend ein.
 */
export function runAdopt(flags: CapabilityFlags): number {
  const cap = resolve(flags, 'adopt');
  if (!cap) return 2;

  const manifest = readManifest(flags.cwd);
  const wasDeclined = manifest.declined[cap.id] !== undefined;
  const wasAdopted = manifest.adopted.includes(cap.id);
  if (wasAdopted && !wasDeclined) {
    log.info(`${cap.label} ist bereits aktiv.`);
    return 0;
  }
  delete manifest.declined[cap.id];
  if (!wasAdopted) manifest.adopted.push(cap.id);
  writeManifest(flags.cwd, manifest, flags.dryRun);
  log.ok(`${cap.label} aufgenommen${flags.dryRun ? ' (Dry-Run)' : ''}.`);
  log.info(c.gray(`Einrichten mit \`udx sync --only ${cap.id}\`.`));
  return 0;
}

/**
 * Dev-facing „add" (D6): nimmt einen Baustein auf — überstimmt dabei eine Auto-Abwahl
 * (z. B. lefthook trotz husky) — und richtet ihn in einem Schritt ein. Entspricht `adopt`
 * gefolgt von `sync --only <id>`. Das in-memory aufgenommene Manifest wird an den sync
 * durchgereicht, damit auch ein `--dry-run` die Aufnahme korrekt vorzeigt (sonst würde der
 * gezielte sync den abgewählten Baustein überspringen) und am Ende einmal persistiert wird.
 */
export function runAdd(flags: AddFlags): number {
  const cap = resolve(flags, 'add');
  if (!cap) return 2;

  const manifest = readManifest(flags.cwd);
  const wasDeclined = manifest.declined[cap.id] !== undefined;
  const wasAdopted = manifest.adopted.includes(cap.id);
  delete manifest.declined[cap.id];
  if (!wasAdopted) manifest.adopted.push(cap.id);

  const note = wasAdopted && !wasDeclined ? 'bereits aktiv' : 'aufgenommen';
  log.ok(`${cap.label} ${note}${flags.dryRun ? ' (Dry-Run)' : ''} — wird eingerichtet.`);

  // `add` ist additiv: fehlende Dateien/Deps anlegen, aber NIE vorhandene überschreiben (auch nicht
  // mit `--force`). Bewusstes Ersetzen einer Config läuft explizit über `udx sync --only <id> --force`.
  return runHarness('sync', { ...flags, only: [cap.id], force: false }, manifest);
}
