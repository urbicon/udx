import { c } from './colors.ts';

export const log = {
  title: (s: string) => console.log(`\n${c.bold(s)}`),
  info: (s: string) => console.log(`  ${s}`),
  step: (s: string) => console.log(`${c.cyan('›')} ${s}`),
  ok: (s: string) => console.log(`  ${c.green('✓')} ${s}`),
  warn: (s: string) => console.log(`  ${c.yellow('!')} ${s}`),
  err: (s: string) => console.error(`  ${c.red('✗')} ${s}`),
  skip: (s: string) => console.log(`  ${c.gray('·')} ${c.gray(s)}`),
  plain: (s = '') => console.log(s),
  /** Mehrzeiligen Block (z. B. einen Diff) eingerückt ausgeben. */
  block: (s: string, pad = '    ') =>
    console.log(
      s
        .split('\n')
        .map((l) => pad + l)
        .join('\n')
    )
};

/** Aktion an einer Datei für die Zusammenfassung. */
export type FileAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'skipped'
  | 'conflict'
  | 'would-create'
  | 'would-update';

export function reportAction(action: FileAction, dest: string, note?: string): void {
  const suffix = note ? c.gray(` (${note})`) : '';
  switch (action) {
    case 'created':
      log.ok(`${c.green('erstellt')}   ${dest}${suffix}`);
      break;
    case 'updated':
      log.ok(`${c.yellow('aktualisiert')} ${dest}${suffix}`);
      break;
    case 'conflict':
      log.warn(`${c.yellow('Konflikt')}     ${dest}${suffix}`);
      break;
    case 'would-create':
      log.info(`${c.green('+ erstellen')}    ${dest}${suffix}`);
      break;
    case 'would-update':
      log.info(`${c.yellow('~ aktualisieren')} ${dest}${suffix}`);
      break;
    case 'unchanged':
      log.skip(`unverändert  ${dest}`);
      break;
    case 'skipped':
      log.skip(`übersprungen ${dest}${suffix}`);
      break;
  }
}
