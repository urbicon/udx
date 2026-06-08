import { createHash } from 'node:crypto';
import { abs, exists, readJson, readText, writeText } from './fs.ts';

export const MANIFEST_FILE = '.udx.json';

/**
 * Projekt-Manifest (`.udx.json`, gehört ins git). Hält fest, was udx zuletzt
 * geschrieben hat und welche Bausteine bewusst abgewählt wurden — die Grundlage
 * für 3-Wege-Drift (statt blind zu überschreiben) und persistente Stack-Entscheidungen.
 */
export interface Manifest {
  /** udx-Version beim letzten Schreiben. */
  harness: string;
  /** Abgewählte Capabilities: id → Grund (erkanntes Konkurrenz-Tool oder `manual`). */
  declined: Record<string, string>;
  /** Explizit aufgenommene Capabilities — überstimmen die Auto-Abwahl (z. B. lefthook trotz husky). */
  adopted: string[];
  /** sha256 des zuletzt von udx geschriebenen Inhalts je managed-Datei. */
  files: Record<string, string>;
}

export function emptyManifest(): Manifest {
  return { harness: '', declined: {}, adopted: [], files: {} };
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Liest `.udx.json`. Fehlend oder beschädigt ⇒ leeres Manifest (nie ein harter Fehler). */
export function readManifest(cwd: string): Manifest {
  const path = abs(cwd, MANIFEST_FILE);
  if (!exists(path)) return emptyManifest();
  try {
    const raw = readJson<Partial<Manifest>>(path);
    return {
      harness: typeof raw.harness === 'string' ? raw.harness : '',
      declined: cleanStringRecord(raw.declined),
      adopted: Array.isArray(raw.adopted) ? raw.adopted.filter((x) => typeof x === 'string') : [],
      files: cleanStringRecord(raw.files)
    };
  } catch {
    return emptyManifest();
  }
}

/** Serialisiert mit stabiler Schlüsselreihenfolge — ruhige git-Diffs zwischen Läufen. */
function serialize(m: Manifest): string {
  return `${JSON.stringify(
    {
      harness: m.harness,
      declined: sortObj(m.declined),
      adopted: [...m.adopted].sort(),
      files: sortObj(m.files)
    },
    null,
    2
  )}\n`;
}

/**
 * Schreibt `.udx.json` nur bei `!dryRun` und nur, wenn sich der Inhalt vom Bestand
 * unterscheidet. Rückgabe = „Inhalt weicht ab" (bei `!dryRun` also tatsächlich geschrieben,
 * bei `dryRun` würde geschrieben) — vom Caller fürs Logging genutzt.
 */
export function writeManifest(cwd: string, manifest: Manifest, dryRun: boolean): boolean {
  const path = abs(cwd, MANIFEST_FILE);
  const next = serialize(manifest);
  const prev = exists(path) ? readText(path) : '';
  if (next === prev) return false;
  if (!dryRun) writeText(path, next);
  return true;
}

/** Behält nur String→String-Paare; verwirft korrupte Einträge (das Manifest ist editierbar). */
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
