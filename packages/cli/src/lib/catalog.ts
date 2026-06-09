import type { PackageJson } from './detect.ts';

/**
 * Bun-Catalog-Tabellen eines Consumers: der Default-Catalog (`workspaces.catalog`) plus benannte
 * Catalogs (`workspaces.catalogs.<name>`). D9 nutzt sie, um die vorgeschriebenen Tool-Versionen
 * statt literal als `catalog:`-Verweis zu führen — aber nur, wenn der Consumer bereits Catalog-First
 * arbeitet. Empirisch (Bun 1.3.14): `catalog:` braucht die Objekt-Form von `workspaces` (Array-Form
 * kann es nicht) und auch ein Single-Package-Root kann `catalog:` für sich selbst auflösen.
 */
export interface CatalogTables {
  /** `workspaces.catalog` (Default). Leeres Objekt, falls (noch) nicht vorhanden. */
  default: Record<string, string>;
  /** `workspaces.catalogs` (benannt: Name → Tabelle). */
  named: Record<string, Record<string, string>>;
}

/** Objekt-Record (kein Array) oder `null`. */
function asRecord(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, string>;
}

/**
 * Liest die Catalog-Tabellen aus der Root-package.json. `null`, wenn `workspaces` fehlt oder in
 * Array-Form vorliegt (kann kein `catalog:`) bzw. weder `catalog` noch `catalogs` definiert ist.
 * Ein Nicht-`null`-Ergebnis ist der Auto-Detect-Trigger für den Catalog-Modus (D9-A) — udx folgt
 * damit der tatsächlichen Realität des Consumers (wie das Wiring), ohne eigenen Manifest-State.
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
  // Objekt-Form, aber gar kein Catalog → kein Catalog-First-Consumer ⇒ literal-Modus.
  if (!def && Object.keys(named).length === 0) return null;
  return { default: def ?? {}, named };
}

export interface CatalogPick {
  /** Ziel-Tabelle: `null` = Default-Catalog, sonst der Name des benannten Catalogs. */
  table: string | null;
  /** devDep-Specifier auf diese Tabelle (`catalog:` bzw. `catalog:<name>`). */
  ref: string;
  /** Aktueller Wert im Catalog (`undefined` = Eintrag fehlt). */
  current: string | undefined;
}

/**
 * Wählt die Catalog-Tabelle für einen Dep — minimal-invasiv (Wiring-Stil): steht er bereits im
 * Default oder in einem benannten Catalog, wird genau dieser gepflegt; sonst landet er im Default.
 * Benannte Catalogs werden nie neu erzeugt, nur genutzt, wenn der Consumer sie schon führt — so
 * zwingt udx dem Consumer keine Catalog-Struktur auf.
 */
export function selectCatalogTable(tables: CatalogTables, dep: string): CatalogPick {
  if (dep in tables.default) return { table: null, ref: 'catalog:', current: tables.default[dep] };
  for (const [name, table] of Object.entries(tables.named)) {
    if (dep in table) return { table: name, ref: `catalog:${name}`, current: table[dep] };
  }
  return { table: null, ref: 'catalog:', current: undefined };
}
