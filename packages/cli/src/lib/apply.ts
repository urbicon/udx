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

export const URBICON_REGISTRY = 'https://codeberg.org/api/packages/urbicon/npm/';
/** Scope-Zeile für bunfig.toml. Token via Env-Var — privates Repo ⇒ auch zum Installieren nötig. */
export const BUNFIG_SCOPE_LINE = `"@urbicon" = { url = "${URBICON_REGISTRY}", token = "$CODEBERG_TOKEN" }`;
const BUNFIG_BLOCK = `# @urbicon-Pakete aus Codebergs Registry. Token via Env-Var (z. B. gitignorte .env):
#   export CODEBERG_TOKEN=<token>
[install.scopes]
${BUNFIG_SCOPE_LINE}
`;

/**
 * Stellt die @urbicon-Registry in bunfig.toml sicher (Bun-natives Pendant zu .npmrc).
 * Additive Idempotenz: erkennt eine bestehende Konfiguration an der Registry-URL. Einen
 * vorhandenen [install.scopes]-Block erweitert die Funktion NICHT automatisch (TOML erlaubt
 * keinen zweiten Tabellen-Header) — sie meldet die zu ergänzende Zeile stattdessen.
 */
export function ensureBunfig(cwd: string, dryRun: boolean): FileResult {
  const dest = 'bunfig.toml';
  const target = abs(cwd, dest);

  if (!exists(target)) {
    if (dryRun) return { dest, action: 'would-create' };
    writeText(target, BUNFIG_BLOCK);
    return { dest, action: 'created' };
  }

  const content = readText(target);
  if (content.includes(URBICON_REGISTRY)) return { dest, action: 'unchanged' };

  if (/^\s*\[install\.scopes\]/m.test(content)) {
    return {
      dest,
      action: 'skipped',
      note: `@urbicon-Scope manuell ergänzen: ${BUNFIG_SCOPE_LINE}`
    };
  }

  if (dryRun) return { dest, action: 'would-update', note: '[install.scopes] fehlt' };
  const sep = content.endsWith('\n') ? '\n' : '\n\n';
  writeText(target, `${content}${sep}${BUNFIG_BLOCK}`);
  return { dest, action: 'updated', note: '[install.scopes] ergänzt' };
}
