import { CAPABILITIES, type Capability, findCapability } from '../lib/capabilities.ts';
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
  log.info('Known building blocks:');
  for (const cap of CAPABILITIES) {
    log.info(`  ${c.cyan(cap.id)} — ${cap.label}${cap.optIn ? c.gray(' (opt-in)') : ''}`);
  }
}

/** Resolves the building block name from the flags; reports & lists on errors. */
function resolve(flags: CapabilityFlags, verb: string): Capability | undefined {
  if (!flags.capability) {
    log.err(`No building block given — e.g. \`udx ${verb} git-hooks\``);
    listCapabilities();
    return undefined;
  }
  const cap = findCapability(flags.capability);
  if (!cap) {
    log.err(`Unknown building block: ${flags.capability}`);
    listCapabilities();
  }
  return cap;
}

/** Declines a building block permanently — init/sync/doctor skip it from now on. */
export function runSkip(flags: CapabilityFlags): number {
  const cap = resolve(flags, 'skip');
  if (!cap) return 2;

  const manifest = readManifest(flags.cwd);
  const alreadyManual =
    manifest.declined[cap.id] === 'manual' && !manifest.adopted.includes(cap.id);
  if (alreadyManual) {
    log.info(`${cap.label} is already declined.`);
    return 0;
  }
  manifest.adopted = manifest.adopted.filter((id) => id !== cap.id);
  manifest.declined[cap.id] = 'manual';
  writeManifest(flags.cwd, manifest, flags.dryRun);
  log.ok(`${cap.label} declined${flags.dryRun ? ' (dry run)' : ''}.`);
  log.info(c.gray(`Existing files remain. Undo: \`udx add ${cap.id}\``));
  return 0;
}

/**
 * Adopts a building block explicitly (overrides the auto-decline, e.g. lefthook despite husky)
 * and removes an existing decline. `udx sync` sets it up afterwards.
 */
export function runAdopt(flags: CapabilityFlags): number {
  const cap = resolve(flags, 'adopt');
  if (!cap) return 2;

  const manifest = readManifest(flags.cwd);
  const wasDeclined = manifest.declined[cap.id] !== undefined;
  const wasAdopted = manifest.adopted.includes(cap.id);
  if (wasAdopted && !wasDeclined) {
    log.info(`${cap.label} is already active.`);
    return 0;
  }
  delete manifest.declined[cap.id];
  if (!wasAdopted) manifest.adopted.push(cap.id);
  writeManifest(flags.cwd, manifest, flags.dryRun);
  log.ok(`${cap.label} adopted${flags.dryRun ? ' (dry run)' : ''}.`);
  log.info(c.gray(`Set up with \`udx sync --only ${cap.id}\`.`));
  return 0;
}

/**
 * Dev-facing "add" (D6): adopts a building block — overriding an auto-decline in the process
 * (e.g. lefthook despite husky) — and sets it up in one step. Equivalent to `adopt`
 * followed by `sync --only <id>`. The in-memory adopted manifest is passed through to the sync,
 * so that even a `--dry-run` shows the adoption correctly (otherwise the targeted sync would skip
 * the declined building block) and it is persisted once at the end.
 */
export function runAdd(flags: AddFlags): number {
  const cap = resolve(flags, 'add');
  if (!cap) return 2;

  const manifest = readManifest(flags.cwd);
  const wasDeclined = manifest.declined[cap.id] !== undefined;
  const wasAdopted = manifest.adopted.includes(cap.id);
  delete manifest.declined[cap.id];
  if (!wasAdopted) manifest.adopted.push(cap.id);

  const note = wasAdopted && !wasDeclined ? 'already active' : 'adopted';
  log.ok(`${cap.label} ${note}${flags.dryRun ? ' (dry run)' : ''} — setting it up.`);

  // `add` is additive: create missing files/deps, but NEVER overwrite existing ones (not even
  // with `--force`). Deliberately replacing a config goes explicitly via `udx sync --only <id> --force`.
  return runHarness('sync', { ...flags, only: [cap.id], force: false }, manifest);
}
