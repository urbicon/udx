import { createHash } from 'node:crypto';
import { abs, exists, readJson, readText, writeText } from './fs.ts';

export const MANIFEST_FILE = '.udx.json';

/**
 * Project manifest (`.udx.json`, belongs in git). Records what udx last wrote
 * and which building blocks were intentionally declined — the foundation for
 * 3-way drift (instead of overwriting blindly) and persistent stack decisions.
 */
export interface Manifest {
  /** udx version at the last write. */
  harness: string;
  /** Declined capabilities: id → reason (detected competing tool or `manual`). */
  declined: Record<string, string>;
  /** Explicitly adopted capabilities — override the auto-decline (e.g. lefthook despite husky). */
  adopted: string[];
  /** sha256 of the content last written by udx, per managed file. */
  files: Record<string, string>;
  /** Intentionally pinned devDeps: name → range at `udx pin`. `sync` leaves them untouched (no bump). */
  pinned: Record<string, string>;
}

export function emptyManifest(): Manifest {
  return { harness: '', declined: {}, adopted: [], files: {}, pinned: {} };
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Reads `.udx.json`. Missing or corrupt ⇒ empty manifest (never a hard error). */
export function readManifest(cwd: string): Manifest {
  const path = abs(cwd, MANIFEST_FILE);
  if (!exists(path)) return emptyManifest();
  try {
    const raw = readJson<Partial<Manifest>>(path);
    return {
      harness: typeof raw.harness === 'string' ? raw.harness : '',
      declined: cleanStringRecord(raw.declined),
      adopted: Array.isArray(raw.adopted) ? raw.adopted.filter((x) => typeof x === 'string') : [],
      files: cleanStringRecord(raw.files),
      pinned: cleanStringRecord(raw.pinned)
    };
  } catch {
    return emptyManifest();
  }
}

/** Serializes with a stable key order — quiet git diffs between runs. */
function serialize(m: Manifest): string {
  return `${JSON.stringify(
    {
      harness: m.harness,
      declined: sortObj(m.declined),
      adopted: [...m.adopted].sort(),
      files: sortObj(m.files),
      pinned: sortObj(m.pinned)
    },
    null,
    2
  )}\n`;
}

/**
 * Writes `.udx.json` only when `!dryRun` and only if the content differs from what's there.
 * Return value = "content differs" (so with `!dryRun` actually written, with `dryRun` it would
 * be written) — used by the caller for logging.
 */
export function writeManifest(cwd: string, manifest: Manifest, dryRun: boolean): boolean {
  const path = abs(cwd, MANIFEST_FILE);
  const next = serialize(manifest);
  const prev = exists(path) ? readText(path) : '';
  if (next === prev) return false;
  if (!dryRun) writeText(path, next);
  return true;
}

/** Keeps only string→string pairs; discards corrupt entries (the manifest is editable). */
function cleanStringRecord(v: unknown): Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function sortObj(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k] as string;
  return out;
}
