import { FILE_TEMPLATES, type FileScope, type RenderCtx } from '../templates/index.ts';
import { formatDiff } from './diff.ts';
import { abs, exists, readText, remove, writeText } from './fs.ts';
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

/**
 * Registry the packages lived on before the 2026-07 move — back when they were scoped
 * `@urbicon` rather than `@urbicon-ui`. Nothing is published there anymore, so a leftover
 * mapping is not merely redundant: it keeps the old scope resolving to frozen copies.
 * Earlier udx versions wrote exactly this block, hence the cleanup below.
 */
export const LEGACY_REGISTRY = 'https://codeberg.org/api/packages/urbicon/npm/';

/**
 * The scope line in either TOML spelling Bun accepts — `"@urbicon" = "<url>"` and the inline
 * table `"@urbicon" = { url = "<url>", … }`. Matched by "key + a line carrying the Codeberg
 * URL" rather than by an exact value, so a token field or single quotes cannot slip past.
 */
const LEGACY_SCOPE_LINE_SRC =
  '[ \\t]*["\']?@urbicon["\']?[ \\t]*=[ \\t]*[^\\n]*codeberg\\.org/api/packages/urbicon/npm[^\\n]*\\r?\\n?';

const LEGACY_SCOPE_LINE = new RegExp(`^${LEGACY_SCOPE_LINE_SRC}`, 'm');

/** The full block written by udx ≤0.2.9 (its own one-line comment + table header + scope line). */
const LEGACY_BUNFIG_BLOCK = new RegExp(
  `(?:^[ \\t]*#[^\\n]*\\r?\\n)?^[ \\t]*\\[install\\.scopes\\][ \\t]*\\r?\\n${LEGACY_SCOPE_LINE_SRC}`,
  'm'
);

/** An [install.scopes] header left behind with no entries under it. */
const EMPTY_INSTALL_SCOPES = /^[ \t]*\[install\.scopes\][ \t]*\r?\n(?=[ \t]*(?:\r?\n)*(?:\[|$))/m;

/**
 * Removes a stale @urbicon → Codeberg mapping from bunfig.toml. Returns `null` when there
 * is nothing to do (the common case), so `init`/`sync` stay silent for projects that never
 * had one. If the whole block was udx-written and nothing else remains, the now-pointless
 * file goes away entirely; a mapping mixed with other scopes loses only its own line.
 * Should no pattern bite (a hand-rolled spelling), the file is left untouched and reported
 * as a manual step — never a silent "updated" that changed nothing.
 */
export function pruneLegacyRegistry(cwd: string, dryRun: boolean): FileResult | null {
  const dest = 'bunfig.toml';
  const target = abs(cwd, dest);
  if (!exists(target)) return null;

  const content = readText(target);
  if (!content.includes(LEGACY_REGISTRY)) return null;

  const note = 'stale @urbicon registry removed — packages are on npm now';
  const pruned = (
    LEGACY_BUNFIG_BLOCK.test(content)
      ? content.replace(LEGACY_BUNFIG_BLOCK, '')
      : content.replace(LEGACY_SCOPE_LINE, '')
  ).replace(EMPTY_INSTALL_SCOPES, '');

  // Nothing matched ⇒ report honestly instead of claiming a write that would be a no-op.
  if (pruned === content) {
    return {
      dest,
      action: 'skipped',
      note: 'remove the stale @urbicon registry mapping by hand — packages are on npm now'
    };
  }
  if (dryRun) return { dest, action: 'would-update', note };

  if (pruned.trim() === '') {
    remove(target);
    return { dest, action: 'updated', note: 'removed — no longer needed' };
  }
  writeText(target, pruned);
  return { dest, action: 'updated', note };
}
