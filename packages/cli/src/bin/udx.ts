#!/usr/bin/env bun
import pkg from '../../package.json' with { type: 'json' };
import { runAdd, runAdopt, runSkip } from '../commands/capability.ts';
import { runDoctor } from '../commands/doctor.ts';
import { type HarnessFlags, runHarness } from '../commands/harness.ts';
import { helpText } from '../commands/help.ts';
import { runPin, runUnpin } from '../commands/pin.ts';
import { runStatus } from '../commands/status.ts';
import { abs, exists } from '../lib/fs.ts';
import { log } from '../lib/log.ts';

const HELP = helpText(pkg.version);

interface CliFlags extends HarnessFlags {
  /** Nicht-Options-Argumente, z. B. der Baustein-Name bei add/remove oder die Dep bei pin. */
  positional: string[];
  /** `--json` (von `status` genutzt). */
  json: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    cwd: process.cwd(),
    dryRun: false,
    force: false,
    svelte: undefined,
    diff: false,
    only: [],
    interactive: false,
    positional: [],
    json: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-n':
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '-f':
      case '--force':
        flags.force = true;
        break;
      case '--diff':
        flags.diff = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '-i':
      case '--interactive':
        flags.interactive = true;
        break;
      case '--only': {
        const v = argv[i + 1];
        if (!v || v.startsWith('-')) {
          log.err('--only braucht eine Id-Liste (z. B. `--only git-hooks`)');
          process.exit(2);
        }
        i++;
        for (const id of v.split(',')) if (id.trim()) flags.only.push(id.trim());
        break;
      }
      case '--svelte':
        flags.svelte = true;
        break;
      case '--no-svelte':
        flags.svelte = false;
        break;
      case '--cwd':
        flags.cwd = argv[++i] ?? flags.cwd;
        break;
      default:
        if (a?.startsWith('-')) {
          log.err(`Unbekannte Option: ${a}`);
          process.exit(2);
        }
        if (a) flags.positional.push(a);
    }
  }
  return flags;
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === '--version' || cmd === '-V') {
  console.log(pkg.version);
  process.exit(0);
}
if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(HELP);
  process.exit(0);
}
if (cmd === undefined) {
  // Bare `udx` in einem Projekt → status (Discoverability); außerhalb eines Projekts → Hilfe.
  if (exists(abs(process.cwd(), 'package.json'))) {
    try {
      process.exit(runStatus({ cwd: process.cwd(), svelte: undefined, json: false }));
    } catch (err) {
      log.err(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
  console.log(HELP);
  process.exit(0);
}

try {
  let code = 0;
  switch (cmd) {
    case 'init':
      code = runHarness('init', parseFlags(rest));
      break;
    case 'sync':
      code = runHarness('sync', parseFlags(rest));
      break;
    case 'doctor': {
      const f = parseFlags(rest);
      code = runDoctor({ cwd: f.cwd, svelte: f.svelte, diff: f.diff });
      break;
    }
    case 'status': {
      const f = parseFlags(rest);
      code = runStatus({ cwd: f.cwd, svelte: f.svelte, json: f.json });
      break;
    }
    case 'add': {
      const f = parseFlags(rest);
      code = runAdd({
        cwd: f.cwd,
        dryRun: f.dryRun,
        force: f.force,
        svelte: f.svelte,
        diff: f.diff,
        only: f.only,
        interactive: f.interactive,
        capability: f.positional[0]
      });
      break;
    }
    // `remove` ist der Dev-facing Name; `skip` bleibt als Back-Compat-Alias (gleiches Verhalten).
    case 'remove':
    case 'skip': {
      const f = parseFlags(rest);
      code = runSkip({ cwd: f.cwd, dryRun: f.dryRun, capability: f.positional[0] });
      break;
    }
    // Back-Compat-Primitive: nur aufnehmen (ohne Einrichten); `udx add` tut beides.
    case 'adopt': {
      const f = parseFlags(rest);
      code = runAdopt({ cwd: f.cwd, dryRun: f.dryRun, capability: f.positional[0] });
      break;
    }
    case 'pin': {
      const f = parseFlags(rest);
      code = runPin({
        cwd: f.cwd,
        dryRun: f.dryRun,
        dep: f.positional[0],
        ...(f.positional[1] ? { range: f.positional[1] } : {})
      });
      break;
    }
    case 'unpin': {
      const f = parseFlags(rest);
      code = runUnpin({ cwd: f.cwd, dryRun: f.dryRun, dep: f.positional[0] });
      break;
    }
    default:
      log.err(`Unbekannter Befehl: ${cmd}`);
      console.log(HELP);
      code = 2;
  }
  process.exit(code);
} catch (err) {
  log.err(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
