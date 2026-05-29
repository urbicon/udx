#!/usr/bin/env bun
import pkg from '../../package.json' with { type: 'json' };
import { runDoctor } from '../commands/doctor.ts';
import { type HarnessFlags, runHarness } from '../commands/harness.ts';
import { c } from '../lib/colors.ts';
import { log } from '../lib/log.ts';

const HELP = `${c.bold('udx')} — urbicon-Entwicklungs-Harness  ${c.gray(`v${pkg.version}`)}

${c.bold('Verwendung')}
  udx <befehl> [optionen]

${c.bold('Befehle')}
  init      Harness in ein Projekt einrichten (Configs, Hooks, Scripts, devDeps)
  sync      Verwaltete Dateien aktualisieren (Prozessverbesserungen nachziehen)
  doctor    Read-only: Projekt auf fehlende/abweichende Harness-Teile prüfen

${c.bold('Optionen')}
  -n, --dry-run    nichts schreiben, nur anzeigen
  -f, --force      auch abweichende managed-Dateien & package.json-Drift überschreiben
      --svelte     Svelte-Setup erzwingen (statt Auto-Erkennung)
      --no-svelte  reines TS-Setup erzwingen
      --cwd <pfad> Zielverzeichnis (Default: aktuelles)
  -h, --help       diese Hilfe
  -V, --version    Version

${c.bold('Beispiele')}
  udx init                 ${c.gray('# neues/bestehendes Projekt einrichten')}
  udx sync --dry-run       ${c.gray('# Vorschau, was ein Update ändern würde')}
  udx sync                 ${c.gray('# Harness-Updates übernehmen')}
  udx doctor               ${c.gray('# Drift prüfen')}
`;

function parseFlags(argv: string[]): HarnessFlags {
  const flags: HarnessFlags = {
    cwd: process.cwd(),
    dryRun: false,
    force: false,
    svelte: undefined
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
    }
  }
  return flags;
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === '--version' || cmd === '-V') {
  console.log(pkg.version);
  process.exit(0);
}
if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
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
      code = runDoctor({ cwd: f.cwd, svelte: f.svelte });
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
