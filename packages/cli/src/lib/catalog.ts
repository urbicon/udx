import type { PackageJson } from './detect.ts';

/**
 * A consumer's Bun catalog tables: the default catalog (`workspaces.catalog`) plus named
 * catalogs (`workspaces.catalogs.<name>`). D9 uses them to carry the prescribed tool versions
 * as a `catalog:` reference instead of a literal — but only if the consumer already works
 * catalog-first. Empirically (Bun 1.3.14): `catalog:` needs the object form of `workspaces`
 * (the array form can't do it) and even a single-package root can resolve `catalog:` for itself.
 */
export interface CatalogTables {
  /** `workspaces.catalog` (default). Empty object if not (yet) present. */
  default: Record<string, string>;
  /** `workspaces.catalogs` (named: name → table). */
  named: Record<string, Record<string, string>>;
}

/** Object record (not an array) or `null`. */
function asRecord(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, string>;
}

/**
 * Reads the catalog tables from the root package.json. `null` if `workspaces` is missing or in
 * array form (can't do `catalog:`), or if neither `catalog` nor `catalogs` is defined.
 * A non-`null` result is the auto-detect trigger for catalog mode (D9-A) — udx thereby follows
 * the consumer's actual reality (like the wiring), without its own manifest state.
 */
export function readCatalogTables(pkg: PackageJson): CatalogTables | null {
  const ws = pkg.workspaces;
  if (!ws || Array.isArray(ws) || typeof ws !== 'object') return null;
  const obj = ws as { catalog?: unknown; catalogs?: unknown };
  const def = asRecord(obj.catalog);
  const namedRaw = asRecord(obj.catalogs);
  const named: Record<string, Record<string, string>> = {};
  if (namedRaw) {
    for (const [name, table] of Object.entries(namedRaw)) {
      const t = asRecord(table);
      if (t) named[name] = t;
    }
  }
  // Object form, but no catalog at all → not a catalog-first consumer ⇒ literal mode.
  if (!def && Object.keys(named).length === 0) return null;
  return { default: def ?? {}, named };
}

export interface CatalogPick {
  /** Target table: `null` = default catalog, otherwise the name of the named catalog. */
  table: string | null;
  /** devDep specifier pointing at this table (`catalog:` or `catalog:<name>`). */
  ref: string;
  /** Current value in the catalog (`undefined` = entry missing). */
  current: string | undefined;
}

/**
 * Selects the catalog table for a dep — minimally invasive (wiring-style): if it already lives in
 * the default or in a named catalog, exactly that one is maintained; otherwise it lands in the default.
 * Named catalogs are never created anew, only used when the consumer already keeps them — that way
 * udx doesn't force any catalog structure onto the consumer.
 */
export function selectCatalogTable(tables: CatalogTables, dep: string): CatalogPick {
  if (dep in tables.default) return { table: null, ref: 'catalog:', current: tables.default[dep] };
  for (const [name, table] of Object.entries(tables.named)) {
    if (dep in table) return { table: name, ref: `catalog:${name}`, current: table[dep] };
  }
  return { table: null, ref: 'catalog:', current: undefined };
}
