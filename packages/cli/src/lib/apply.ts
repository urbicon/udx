import { FILE_TEMPLATES, type RenderCtx } from '../templates/index.ts';
import { abs, exists, readText, writeText } from './fs.ts';
import type { FileAction } from './log.ts';

export interface ApplyOptions {
  mode: 'init' | 'sync';
  dryRun: boolean;
  /** Überschreibt auch managed-Dateien, die im init-Modus bereits abweichen. */
  force: boolean;
}

export interface FileResult {
  dest: string;
  action: FileAction;
  note?: string;
}

export function applyFiles(cwd: string, ctx: RenderCtx, opts: ApplyOptions): FileResult[] {
  const results: FileResult[] = [];

  for (const t of FILE_TEMPLATES) {
    if (t.applies && !t.applies(ctx)) continue;

    const target = abs(cwd, t.dest);
    const content = t.render(ctx);

    if (!exists(target)) {
      if (opts.dryRun) results.push({ dest: t.dest, action: 'would-create' });
      else {
        writeText(target, content, t.mode);
        results.push({ dest: t.dest, action: 'created' });
      }
      continue;
    }

    if (readText(target) === content) {
      results.push({ dest: t.dest, action: 'unchanged' });
      continue;
    }

    if (t.policy === 'create-only') {
      results.push({ dest: t.dest, action: 'skipped', note: 'create-only, vorhanden' });
      continue;
    }

    // managed + weicht ab
    const shouldWrite = opts.mode === 'sync' || opts.force;
    if (!shouldWrite) {
      results.push({
        dest: t.dest,
        action: 'skipped',
        note: 'weicht ab — mit `udx sync` aktualisieren'
      });
      continue;
    }
    if (opts.dryRun) results.push({ dest: t.dest, action: 'would-update' });
    else {
      writeText(target, content, t.mode);
      results.push({ dest: t.dest, action: 'updated' });
    }
  }

  return results;
}

const NPMRC_LINE = '@urbicon:registry=https://codeberg.org/api/packages/urbicon/npm/';

export function ensureNpmrc(cwd: string, dryRun: boolean): FileResult {
  const target = abs(cwd, '.npmrc');

  if (!exists(target)) {
    if (dryRun) return { dest: '.npmrc', action: 'would-create' };
    writeText(target, `${NPMRC_LINE}\n`);
    return { dest: '.npmrc', action: 'created' };
  }

  const content = readText(target);
  if (content.includes('@urbicon:registry=')) return { dest: '.npmrc', action: 'unchanged' };

  if (dryRun) return { dest: '.npmrc', action: 'would-update', note: 'Registry-Zeile fehlt' };
  const sep = content.endsWith('\n') ? '' : '\n';
  writeText(target, `${content}${sep}${NPMRC_LINE}\n`);
  return { dest: '.npmrc', action: 'updated', note: 'Registry-Zeile ergänzt' };
}
