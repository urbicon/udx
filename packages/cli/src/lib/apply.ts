import { FILE_TEMPLATES, type FileScope, type RenderCtx } from '../templates/index.ts';
import { formatDiff } from './diff.ts';
import { abs, exists, readText, writeText } from './fs.ts';
import type { FileAction } from './log.ts';
import { hashContent, type Manifest } from './manifest.ts';

export interface ApplyOptions {
  mode: 'init' | 'sync';
  dryRun: boolean;
  /** Also overwrites managed files that were locally modified. */
  force: boolean;
  /** For managed drift, include the difference (local → template) in the FileResult. */
  diff?: boolean;
  /** Only process templates of this scope; omitted = all (single-package). */
  scope?: FileScope;
}

export interface FileResult {
  dest: string;
  /** FILE_TEMPLATE id (only for template files; e.g. `bunfig.toml` has none). */
  id?: string;
  action: FileAction;
  note?: string;
  /** Colored diff local → template (only set when `opts.diff` and drift is present). */
  diff?: string;
}

/**
 * Applies the FILE_TEMPLATES to the project. For managed files, 3-way drift applies:
 * if an existing file diverges from the template, the hash of the content last written
 * by udx remembered in the `manifest` decides whether it is untouched-stale
 * (→ safe to update) or locally modified (→ protect, only `--force` overwrites).
 * Writes managed hashes idempotently into the `manifest` (persisted by the caller).
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
    // Scope filter: in the monorepo the caller separates root from package building blocks.
    if (opts.scope && (t.scope ?? 'root') !== opts.scope) continue;
    if (t.applies && !t.applies(ctx)) continue;
    // --only: restrict to the selected building blocks (the rest stays untouched).
    if (only && !only.has(t.id)) continue;

    // Declined capability (e.g. lefthook when husky is present) → do not manage.
    const declinedReason = declined.get(t.id);
    if (declinedReason) {
      results.push({
        dest: t.dest,
        id: t.id,
        action: 'skipped',
        note: `declined (${declinedReason})`
      });
      continue;
    }

    const target = abs(cwd, t.dest);
    const content = t.render(ctx);
    const remember = (): void => {
      if (t.policy === 'managed' && !opts.dryRun) manifest.files[t.dest] = hashContent(content);
    };

    // 1. File missing → create it.
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

    // 2. Already up to date — record the hash (covers the first migration without a manifest).
    if (local === content) {
      remember();
      results.push({ dest: t.dest, id: t.id, action: 'unchanged' });
      continue;
    }

    // 3. create-only: by default never touch an existing file. Exception: a deliberate, targeted
    //    replacement (`--force` AND explicitly selected via `--only`) adopts the udx template — this
    //    lets you wire up a self-managed config, for example. Bare `--force` leaves create-only untouched.
    if (t.policy === 'create-only') {
      if (!(opts.force && only?.has(t.id))) {
        results.push({ dest: t.dest, id: t.id, action: 'skipped', note: 'create-only, exists' });
        continue;
      }
      let res: FileResult;
      if (opts.dryRun) res = { dest: t.dest, id: t.id, action: 'would-update' };
      else {
        writeText(target, content, t.mode);
        res = { dest: t.dest, id: t.id, action: 'updated' };
      }
      if (opts.diff) {
        const d = formatDiff(local, content, { color: true });
        if (d) res.diff = d;
      }
      results.push(res);
      continue;
    }

    // 4. managed + diverges → 3-way decision based on the remembered hash.
    const known = manifest.files[t.dest];
    const pristine = known !== undefined && hashContent(local) === known;
    const allowUpdate = pristine ? opts.mode === 'sync' || opts.force : opts.force;

    let result: FileResult;
    if (!allowUpdate) {
      result = pristine
        ? { dest: t.dest, id: t.id, action: 'skipped', note: 'stale — `udx sync` updates it' }
        : {
            dest: t.dest,
            id: t.id,
            action: 'conflict',
            note: 'locally modified — `--force` overwrites'
          };
    } else if (opts.dryRun) {
      result = { dest: t.dest, id: t.id, action: 'would-update' };
    } else {
      writeText(target, content, t.mode);
      remember();
      result = { dest: t.dest, id: t.id, action: 'updated' };
    }

    // Diff computed from `local` before the (possible) write: shows what changes.
    if (opts.diff) {
      const d = formatDiff(local, content, { color: true });
      if (d) result.diff = d;
    }
    results.push(result);
  }

  return results;
}

export const URBICON_REGISTRY = 'https://codeberg.org/api/packages/urbicon/npm/';
/** Scope line for bunfig.toml. The @urbicon registry on Codeberg is public — no token to install. */
export const BUNFIG_SCOPE_LINE = `"@urbicon" = "${URBICON_REGISTRY}"`;
const BUNFIG_BLOCK = `# @urbicon packages from Codeberg's public registry — no token needed to install.
[install.scopes]
${BUNFIG_SCOPE_LINE}
`;

/** Existing [install.scopes] header (TOML allows no second one) — top-level regex. */
const INSTALL_SCOPES_HEADER = /^\s*\[install\.scopes\]/m;

/**
 * Ensures the @urbicon registry in bunfig.toml (Bun-native counterpart to .npmrc).
 * Additive idempotency: detects an existing configuration by the registry URL. It does NOT
 * automatically extend an existing [install.scopes] block (TOML allows no second table header)
 * — instead it reports the line that needs to be added.
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

  if (INSTALL_SCOPES_HEADER.test(content)) {
    return {
      dest,
      action: 'skipped',
      note: `add the @urbicon scope manually: ${BUNFIG_SCOPE_LINE}`
    };
  }

  if (dryRun) return { dest, action: 'would-update', note: '[install.scopes] missing' };
  const sep = content.endsWith('\n') ? '\n' : '\n\n';
  writeText(target, `${content}${sep}${BUNFIG_BLOCK}`);
  return { dest, action: 'updated', note: '[install.scopes] added' };
}
