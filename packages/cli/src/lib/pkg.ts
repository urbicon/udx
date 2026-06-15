import { type CatalogTables, selectCatalogTable } from './catalog.ts';
import type { PackageJson, ProjectContext } from './detect.ts';
import {
  type DepName,
  RENAMED_FROM,
  SVELTE_DEPS,
  TOOL_DEPS,
  URBICON_DEPS,
  VERSIONS
} from './versions.ts';

export interface PkgChange {
  name: string;
  to: string;
  from?: string;
}

/** Eine Catalog-Eintrags-Änderung (D9): Dep-Name + Zieltabelle (`null` = Default-Catalog). */
export interface CatalogChange {
  name: string;
  /** `null` = Default-Catalog (`workspaces.catalog`), sonst der Name des benannten Catalogs. */
  table: string | null;
  to: string;
  from?: string;
}

export interface PkgPlan {
  scriptsToAdd: PkgChange[];
  scriptsDrift: PkgChange[];
  devDepsToAdd: PkgChange[];
  devDepsDrift: PkgChange[];
  /** Hinter dem Pin, aber bewusst gehalten (`udx pin`) — wird nicht angehoben, nur zur Sicht gemeldet. */
  devDepsPinned: PkgChange[];
  /** D9 Catalog-Modus: fehlender Catalog-Eintrag (wird mit dem `catalog:`-devDep atomar angelegt). */
  catalogEntriesToAdd: CatalogChange[];
  /** D9 Catalog-Modus: vorhandener Eintrag hinter Pin/literaler devDep → sicher anheben (nie Downgrade). */
  catalogEntriesDrift: CatalogChange[];
  /** D9 Catalog-Modus: literale/abweichende devDep → auf `catalog:`/`catalog:<name>` umstellen (`to` = ref). */
  devDepsToCatalog: PkgChange[];
  /** Umbenannter Tool-Dep unter altem Namen (`RENAMED_FROM`) → entfernen; `to` = der Nachfolger. */
  devDepsToRemove: PkgChange[];
}

const URBICON_SET = new Set<string>(URBICON_DEPS);

/**
 * Platzierungs-Tier eines Bausteins im Monorepo (D9-C):
 * - `root`   – repo-globale Tools + TS-Toolchain + nicht-svelte Lint/Format (laufen einmal fürs Repo).
 * - `svelte` – svelte-Deps + svelte-flavored Lint/Format, je Svelte-Paket (svelte-check braucht die
 *   Paket-eigene tsconfig).
 * Kein Tier (Single-Package) = beide kombiniert, exakt das bisherige Verhalten.
 */
export type DepTier = 'root' | 'svelte';

const SVELTE_FORMAT = 'biome format --write . && prettier --write "**/*.svelte"';
const SVELTE_LINT = 'biome check . && svelte-check --tsconfig ./tsconfig.json';
const BASE_FORMAT = 'biome format --write .';
const BASE_LINT = 'biome check .';

/** Repo-globale Scripts — laufen einmal fürs ganze Projekt, nie per Sub-Paket. */
const REPO_GLOBAL_SCRIPTS: Record<string, string> = {
  fix: 'biome check --write .',
  changelog: 'git-cliff --output CHANGELOG.md',
  bump: 'bash scripts/bump.sh patch',
  'bump:minor': 'bash scripts/bump.sh minor',
  'bump:major': 'bash scripts/bump.sh major',
  prepare: 'lefthook install'
};

export function canonicalScripts(ctx: ProjectContext, tier?: DepTier): Record<string, string> {
  // svelte-Tier: nur die svelte-flavored Format/Lint (per Svelte-Paket); ohne Svelte leer.
  if (tier === 'svelte') return ctx.svelte ? { format: SVELTE_FORMAT, lint: SVELTE_LINT } : {};
  // root-Tier: repo-globale Scripts + nicht-svelte Format/Lint (biome deckt alle Pakete ab).
  if (tier === 'root') return { format: BASE_FORMAT, lint: BASE_LINT, ...REPO_GLOBAL_SCRIPTS };
  // Kein Tier (Single-Package): alles, svelte-flavored falls svelte — bisheriges Verhalten.
  const format = ctx.svelte ? SVELTE_FORMAT : BASE_FORMAT;
  const lint = ctx.svelte ? SVELTE_LINT : BASE_LINT;
  return { format, lint, ...REPO_GLOBAL_SCRIPTS };
}

/** root-Tier devDeps: repo-globale Tools + TS-Toolchain + @urbicon-Presets (alles außer svelte). */
const ROOT_TIER_DEPS: readonly DepName[] = [...TOOL_DEPS, ...URBICON_DEPS];

export function canonicalDevDeps(
  ctx: ProjectContext,
  tier?: DepTier
): Partial<Record<DepName, string>> {
  const out: Partial<Record<DepName, string>> = {};
  const add = (names: readonly DepName[]): void => {
    for (const n of names) out[n] = VERSIONS[n];
  };
  if (tier === undefined || tier === 'root') add(ROOT_TIER_DEPS);
  if ((tier === undefined || tier === 'svelte') && ctx.svelte) add(SVELTE_DEPS);
  return out;
}

/** Versions-Range-Parsing — Top-Level-Regexe (laufen je Dependency in Schleifen). */
const WHITESPACE = /\s+/;
const SEMVER_TOKEN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const VERSION_RANGE = /^[v^~>=<\s]*\d/;
const SIMPLE_RANGE = /^([v^~>=]*)\d[\w.+-]*$/;

/**
 * Floor (untere Schranke) einer Range: `^1.2.3`→`1.2.3`, `>=2.0.0 <3`→`2.0.0`, `<3 >=2`→`2.0.0`.
 * Obergrenzen (`<…`) werden übersprungen, damit auch umgekehrt notierte Compound-Ranges den
 * tatsächlichen Floor liefern (nicht versehentlich die Obergrenze).
 */
function floorVersion(range: string): string | null {
  for (const token of range.trim().split(WHITESPACE)) {
    if (token.startsWith('<')) continue; // Obergrenze ist nicht der Floor
    const m = token.match(SEMVER_TOKEN);
    if (m) return m[0];
  }
  return null;
}

/**
 * Reiner Versions-Range (führende Operatoren `v^~>=<`, dann eine Ziffer)? Protokolle wie
 * `catalog:`/`workspace:`/`npm:`/`github:`/`git+…` beginnen mit einem Buchstaben → `false`.
 */
function isVersionRange(s: string): boolean {
  return VERSION_RANGE.test(s);
}

/**
 * Hebt `current` auf mindestens `target` an (Floor-Vergleich, semver-bewusst) — nie ein Downgrade.
 * Liegt `current` bereits ≥ `target` (oder ist nicht vergleichbar: Protokoll, `*`), bleibt es
 * unverändert (auch Build-Metadaten/Pre-Release bleiben so erhalten). Beim Anheben behält eine
 * einfache Single-Token-Range (`^`/`~`/`>=`/`v` + Version) ihren Operator; eine Compound-/exotische
 * Range wird durch das saubere `target` ersetzt, statt eine kaputte Range zu bauen. Grundlage der
 * Catalog-Pflege (D9-E); verwandt mit dem operator-erhaltenden Anheben in `scripts/stack-update.ts`
 * (dort gegen die Registry, hier gegen den udx-Pin).
 */
export function raise(current: string, target: string): string {
  const cf = floorVersion(current);
  const tf = floorVersion(target);
  if (cf === null || tf === null) return current; // nicht vergleichbar → unverändert
  if (Bun.semver.order(cf, tf) >= 0) return current; // current ≥ target → kein Downgrade
  const simple = current.trim().match(SIMPLE_RANGE);
  return simple ? `${simple[1]}${tf}` : target;
}

/**
 * Die Pins in `versions.ts` sind eine **Baseline** (Mindestversion), kein exakter Sollwert: hat ein
 * Projekt bereits eine neuere, kompatible Version, ist der Pin erfüllt — udx zieht Projekte aufs
 * Minimum hoch, setzt sie aber nie herunter (sonst entstünde das @types/node-Downgrade). Nur eine
 * echt ältere Version gilt als Drift. Nicht-Versions-Specifier (`workspace:`/`catalog:`/`npm:`-Alias,
 * git-URL, `*`, …) regeln die Version anderswo bzw. zeigen auf ein anderes Paket und gelten als
 * erfüllt — ein Downgrade von etwas, das wir nicht semantisch vergleichen können, wäre gefährlich.
 */
export function satisfiesPin(current: string, pin: string): boolean {
  // Nur reine Versions-Ranges vergleichen: Protokolle (`workspace:`/`catalog:`/`npm:`/`github:`/`git+…`)
  // beginnen mit einem Buchstaben → gelten als erfüllt (Version anderswo geregelt, nie blind downgraden).
  if (!isVersionRange(current)) return true;
  const cur = floorVersion(current);
  const want = floorVersion(pin);
  if (cur === null || want === null) return true;
  return Bun.semver.order(cur, want) >= 0;
}

export interface PkgSet {
  scripts?: ReadonlySet<string>;
  devDeps?: ReadonlySet<string>;
}

/** Filter für den Plan: `skip` nimmt Bausteine raus (abgewählt), `only` beschränkt (Whitelist), `pinned` hält devDeps. */
export interface PkgFilter {
  skip?: PkgSet;
  only?: PkgSet;
  pinned?: ReadonlySet<string>;
}

export function computePkgPlan(
  ctx: ProjectContext,
  filter: PkgFilter = {},
  tier?: DepTier,
  /** Catalog-Tabellen des Consumers (vom Caller aus dem Root-pkg gelesen); `null` ⇒ literal-Modus (D9-A). */
  catalog: CatalogTables | null = null
): PkgPlan {
  const plan: PkgPlan = {
    scriptsToAdd: [],
    scriptsDrift: [],
    devDepsToAdd: [],
    devDepsDrift: [],
    devDepsPinned: [],
    catalogEntriesToAdd: [],
    catalogEntriesDrift: [],
    devDepsToCatalog: [],
    devDepsToRemove: []
  };
  const scripts = ctx.pkg.scripts ?? {};
  const devDeps = ctx.pkg.devDependencies ?? {};
  const { skip, only, pinned } = filter;

  for (const [name, to] of Object.entries(canonicalScripts(ctx, tier))) {
    if (only?.scripts && !only.scripts.has(name)) continue;
    if (skip?.scripts?.has(name)) continue;
    const current = scripts[name];
    if (current === undefined) plan.scriptsToAdd.push({ name, to });
    else if (current !== to) plan.scriptsDrift.push({ name, to, from: current });
  }

  for (const [name, to] of Object.entries(canonicalDevDeps(ctx, tier))) {
    if (only?.devDeps && !only.devDeps.has(name)) continue;
    if (skip?.devDeps?.has(name)) continue;
    const current = devDeps[name];
    const pin = to as string;
    // Bewusst gehalten (`udx pin`) → unberührt lassen (kein Anheben, kein Ergänzen, kein catalog:-Switch),
    // aber stets melden — auch wenn nicht installiert —, damit ein aktiver Pin nie still „verschwindet".
    // Steht VOR der Catalog-Logik: ein Switch auf `catalog:` würde den Pin sonst unterlaufen.
    if (pinned?.has(name)) {
      plan.devDepsPinned.push(
        current !== undefined ? { name, to: pin, from: current } : { name, to: pin }
      );
      continue;
    }

    // Vorgänger-Name dieses Deps (RENAMED_FROM) noch installiert → entfernen, der Nachfolger
    // wird in diesem Plan geführt. Innerhalb der Schleife, damit --only/skip automatisch greifen;
    // ein `udx pin <alt>` hält den alten Namen bewusst (dann keine Entfernung).
    const renamed = RENAMED_FROM[name as DepName];
    if (renamed && devDeps[renamed] !== undefined && !pinned?.has(renamed)) {
      plan.devDepsToRemove.push({ name: renamed, from: devDeps[renamed], to: name });
    }

    // Literal-Modus (kein Catalog) oder @urbicon/* (unified mit der CLI-Version, nie via Catalog/Renovate
    // bumpen, D9-D) → bisheriges Verhalten: literale Version ergänzen bzw. sicher anheben.
    if (catalog === null || URBICON_SET.has(name)) {
      if (current === undefined) plan.devDepsToAdd.push({ name, to: pin });
      else if (!satisfiesPin(current, pin))
        plan.devDepsDrift.push({ name, to: pin, from: current });
      continue;
    }

    // Catalog-Modus (D9): den Eintrag pflegen UND die devDep auf `catalog:` führen. Beide entstehen im
    // selben Plan, damit WP3 sie atomar schreibt — ein `catalog:` ohne Eintrag bricht `bun install`.
    const pick = selectCatalogTable(catalog, name);
    const literal = current !== undefined && isVersionRange(current) ? current : undefined;
    if (pick.current === undefined) {
      // Neuer Eintrag: Pin als Basis, auf eine evtl. höhere literale devDep anheben (nie Downgrade, D9-E).
      plan.catalogEntriesToAdd.push({
        name,
        table: pick.table,
        to: literal ? raise(pin, literal) : pin
      });
    } else {
      // Vorhandener Eintrag: anheben, wenn hinter dem Pin oder hinter einer literalen devDep.
      let entry = pick.current;
      if (!satisfiesPin(pick.current, pin)) entry = raise(entry, pin);
      if (literal && !satisfiesPin(pick.current, literal)) entry = raise(entry, literal);
      if (entry !== pick.current)
        plan.catalogEntriesDrift.push({ name, table: pick.table, from: pick.current, to: entry });
    }
    // devDep auf den Catalog-Verweis führen (Eintrag ist durch obiges garantiert vorhanden/geplant).
    if (current === undefined) plan.devDepsToAdd.push({ name, to: pick.ref });
    else if (current !== pick.ref)
      plan.devDepsToCatalog.push({ name, from: current, to: pick.ref });
  }

  return plan;
}

function sortKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k] as string;
  return out;
}

/**
 * Wendet den Plan auf das pkg-Objekt an (Scripts + devDeps des jeweiligen Pakets). Fehlende
 * Scripts/devDeps, Versions-Drift und der `catalog:`-Switch werden immer angewandt — `satisfiesPin`
 * garantiert, dass das nie ein Downgrade ist (der Switch wird vom Catalog-Eintrag gedeckt), daher
 * braucht das kein `--force`. Nur Script-Drift kann eine bewusste Anpassung sein → `--force`.
 * Die Catalog-EINTRÄGE selbst schreibt `applyCatalogEntries` ins Root-pkg (sie leben nur dort).
 * Gibt true zurück, wenn geändert.
 */
export function mutatePkg(pkg: PackageJson, plan: PkgPlan, force: boolean): boolean {
  let changed = false;
  const scripts = { ...(pkg.scripts ?? {}) };
  const devDeps = { ...(pkg.devDependencies ?? {}) };

  for (const ch of plan.scriptsToAdd) {
    scripts[ch.name] = ch.to;
    changed = true;
  }
  for (const ch of plan.devDepsToAdd) {
    devDeps[ch.name] = ch.to;
    changed = true;
  }
  // Sicheres Anheben hinter dem Pin liegender Versionen (nie Downgrade) — ohne --force.
  for (const ch of plan.devDepsDrift) {
    devDeps[ch.name] = ch.to;
    changed = true;
  }
  // Catalog-Modus: literale devDep auf `catalog:`/`catalog:<name>` umstellen (Eintrag von
  // applyCatalogEntries gedeckt) — kein Downgrade, daher ohne --force.
  for (const ch of plan.devDepsToCatalog) {
    devDeps[ch.name] = ch.to;
    changed = true;
  }
  // Alter Name eines umbenannten Tool-Deps — der Nachfolger ist im selben Plan garantiert
  // geführt (gleiche Schleifen-Iteration), daher gefahrlos ohne --force.
  for (const ch of plan.devDepsToRemove) {
    delete devDeps[ch.name];
    changed = true;
  }
  if (force) {
    for (const ch of plan.scriptsDrift) {
      scripts[ch.name] = ch.to;
      changed = true;
    }
  }

  if (changed) {
    if (Object.keys(scripts).length > 0) pkg.scripts = scripts;
    if (Object.keys(devDeps).length > 0) pkg.devDependencies = sortKeys(devDeps);
  }
  return changed;
}

/**
 * Trägt die Catalog-Einträge (add + drift) des Plans in das mutable `catalog`-Arbeitsobjekt ein.
 * Dieses wird über alle Paket-Patches eines Laufs geteilt, sodass die Akkumulation über mehrere
 * Svelte-Pakete hinweg greift (D9-E): ein zweites Paket sieht den vom ersten angelegten/angehobenen
 * Eintrag und hebt nur weiter an, statt ihn zu überschreiben. `wireCatalog` schreibt das Ergebnis am
 * Ende ins Root-pkg. Gibt true zurück, wenn ein Eintrag geändert wurde.
 */
export function applyCatalogEntries(catalog: CatalogTables | null, plan: PkgPlan): boolean {
  const entries = [...plan.catalogEntriesToAdd, ...plan.catalogEntriesDrift];
  if (entries.length === 0 || catalog === null) return false;
  for (const ch of entries) {
    if (ch.table === null) {
      catalog.default[ch.name] = ch.to;
    } else {
      const table = catalog.named[ch.table] ?? {};
      table[ch.name] = ch.to;
      catalog.named[ch.table] = table;
    }
  }
  return true;
}

/**
 * Verdrahtet die (ggf. neu befüllten) Catalog-Tabellen zurück in `rootPkg.workspaces` — Bun-Catalogs
 * leben ausschließlich in der Workspace-Root. Zeigt eine Tabelle bereits auf das Consumer-Objekt, ist
 * das ein No-op (gleiche Referenz); ein neu angelegter Default-Catalog wird hier eingehängt. Leere
 * Tabellen bleiben außen vor, damit kein leerer `catalog: {}`-Block entsteht.
 */
export function wireCatalog(rootPkg: PackageJson, catalog: CatalogTables): void {
  const ws = (
    typeof rootPkg.workspaces === 'object' && !Array.isArray(rootPkg.workspaces)
      ? rootPkg.workspaces
      : {}
  ) as { catalog?: Record<string, string>; catalogs?: Record<string, Record<string, string>> };
  rootPkg.workspaces = ws;
  if (Object.keys(catalog.default).length > 0) ws.catalog = catalog.default;
  for (const [name, table] of Object.entries(catalog.named)) {
    if (Object.keys(table).length === 0) continue;
    ws.catalogs ??= {};
    ws.catalogs[name] = table;
  }
}
