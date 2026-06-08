import { FILE_TEMPLATES, type RenderCtx } from '../templates/index.ts';
import { formatDiff } from './diff.ts';
import { abs, exists, readText, writeText } from './fs.ts';
import type { FileAction } from './log.ts';
import { hashContent, type Manifest } from './manifest.ts';

export interface ApplyOptions {
  mode: 'init' | 'sync';
  dryRun: boolean;
  /** Überschreibt auch managed-Dateien, die lokal verändert wurden. */
  force: boolean;
  /** Bei managed-Drift den Unterschied (lokal → Template) im FileResult mitliefern. */
  diff?: boolean;
}

export interface FileResult {
  dest: string;
  /** FILE_TEMPLATE-Id (nur für Template-Dateien; z. B. `bunfig.toml` hat keine). */
  id?: string;
  action: FileAction;
  note?: string;
  /** Gefärbter Diff lokal → Template (nur gesetzt, wenn `opts.diff` und Drift vorliegt). */
  diff?: string;
}

/**
 * Wendet die FILE_TEMPLATES auf das Projekt an. Für managed-Dateien gilt 3-Wege-Drift:
 * weicht eine vorhandene Datei vom Template ab, entscheidet der im `manifest` gemerkte
 * Hash des zuletzt von udx geschriebenen Inhalts, ob sie unberührt-veraltet ist
 * (→ sicher aktualisieren) oder lokal verändert (→ schützen, nur `--force` überschreibt).
 * Schreibt managed-Hashes idempotent ins `manifest` (vom Caller persistiert).
 */
export function applyFiles(
  cwd: string,
  ctx: RenderCtx,
  opts: ApplyOptions,
  manifest: Manifest,
  declined: ReadonlyMap<string, string> = new Map(),
  only: ReadonlySet<string> | null = null
): FileResult[] {
  const results: FileResult[] = [];

  for (const t of FILE_TEMPLATES) {
    if (t.applies && !t.applies(ctx)) continue;
    // --only: auf die ausgewählten Bausteine beschränken (der Rest bleibt unberührt).
    if (only && !only.has(t.id)) continue;

    // Abgewählte Capability (z. B. lefthook bei vorhandenem husky) → nicht verwalten.
    const declinedReason = declined.get(t.id);
    if (declinedReason) {
      results.push({
        dest: t.dest,
        id: t.id,
        action: 'skipped',
        note: `abgewählt (${declinedReason})`
      });
      continue;
    }

    const target = abs(cwd, t.dest);
    const content = t.render(ctx);
    const remember = () => {
      if (t.policy === 'managed' && !opts.dryRun) manifest.files[t.dest] = hashContent(content);
    };

    // 1. Datei fehlt → anlegen.
    if (!exists(target)) {
      if (opts.dryRun) results.push({ dest: t.dest, id: t.id, action: 'would-create' });
      else {
        writeText(target, content, t.mode);
        remember();
        results.push({ dest: t.dest, id: t.id, action: 'created' });
      }
      continue;
    }

    const local = readText(target);

    // 2. Bereits aktuell — Hash nachtragen (deckt Erstmigration ohne Manifest ab).
    if (local === content) {
      remember();
      results.push({ dest: t.dest, id: t.id, action: 'unchanged' });
      continue;
    }

    // 3. create-only: vorhandene Datei nie anfassen.
    if (t.policy === 'create-only') {
      results.push({ dest: t.dest, id: t.id, action: 'skipped', note: 'create-only, vorhanden' });
      continue;
    }

    // 4. managed + weicht ab → 3-Wege-Entscheidung anhand des gemerkten Hashes.
    const known = manifest.files[t.dest];
    const pristine = known !== undefined && hashContent(local) === known;
    const allowUpdate = pristine ? opts.mode === 'sync' || opts.force : opts.force;

    let result: FileResult;
    if (!allowUpdate) {
      result = pristine
        ? { dest: t.dest, id: t.id, action: 'skipped', note: 'veraltet — `udx sync` aktualisiert' }
        : {
            dest: t.dest,
            id: t.id,
            action: 'conflict',
            note: 'lokal geändert — `--force` überschreibt'
          };
    } else if (opts.dryRun) {
      result = { dest: t.dest, id: t.id, action: 'would-update' };
    } else {
      writeText(target, content, t.mode);
      remember();
      result = { dest: t.dest, id: t.id, action: 'updated' };
    }

    // Diff vor dem (möglichen) Schreiben aus `local` berechnet: zeigt, was sich ändert.
    if (opts.diff) {
      const d = formatDiff(local, content, { color: true });
      if (d) result.diff = d;
    }
    results.push(result);
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
