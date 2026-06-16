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

/** A catalog entry change (D9): dep name + target table (`null` = default catalog). */
export interface CatalogChange {
  name: string;
  /** `null` = default catalog (`workspaces.catalog`), otherwise the name of the named catalog. */
  table: string | null;
  to: string;
  from?: string;
}

export interface PkgPlan {
  scriptsToAdd: PkgChange[];
  scriptsDrift: PkgChange[];
  devDepsToAdd: PkgChange[];
  devDepsDrift: PkgChange[];
  /** Behind the pin, but intentionally pinned (`udx pin`) — not bumped, only reported for visibility. */
  devDepsPinned: PkgChange[];
  /** D9 catalog mode: missing catalog entry (created atomically alongside the `catalog:` devDep). */
  catalogEntriesToAdd: CatalogChange[];
  /** D9 catalog mode: existing entry behind pin/literal devDep → bump safely (never a downgrade). */
  catalogEntriesDrift: CatalogChange[];
  /** D9 catalog mode: literal/diverging devDep → switch to `catalog:`/`catalog:<name>` (`to` = ref). */
  devDepsToCatalog: PkgChange[];
  /** Renamed tool dep still under its old name (`RENAMED_FROM`) → remove; `to` = the successor. */
  devDepsToRemove: PkgChange[];
}

const URBICON_SET = new Set<string>(URBICON_DEPS);

/**
 * Placement tier of a building block in the monorepo (D9-C):
 * - `root`   – repo-global tools + TS toolchain + non-svelte lint/format (run once for the repo).
 * - `svelte` – svelte deps + svelte-flavored lint/format, per Svelte package (svelte-check needs the
 *   package's own tsconfig).
 * No tier (single-package) = both combined, exactly the previous behavior.
 */
export type DepTier = 'root' | 'svelte';

const SVELTE_FORMAT = 'biome format --write . && prettier --write "**/*.svelte"';
const SVELTE_LINT = 'biome check . && svelte-check --tsconfig ./tsconfig.json';
const BASE_FORMAT = 'biome format --write .';
const BASE_LINT = 'biome check .';

/** Repo-global scripts — run once for the whole project, never per sub-package. */
const REPO_GLOBAL_SCRIPTS: Record<string, string> = {
  fix: 'biome check --write .',
  changelog: 'git-cliff --output CHANGELOG.md',
  bump: 'bash scripts/bump.sh patch',
  'bump:minor': 'bash scripts/bump.sh minor',
  'bump:major': 'bash scripts/bump.sh major',
  prepare: 'lefthook install'
};

export function canonicalScripts(ctx: ProjectContext, tier?: DepTier): Record<string, string> {
  // svelte tier: only the svelte-flavored format/lint (per Svelte package); empty without Svelte.
  if (tier === 'svelte') return ctx.svelte ? { format: SVELTE_FORMAT, lint: SVELTE_LINT } : {};
  // root tier: repo-global scripts + non-svelte format/lint (biome covers all packages).
  if (tier === 'root') return { format: BASE_FORMAT, lint: BASE_LINT, ...REPO_GLOBAL_SCRIPTS };
  // No tier (single-package): everything, svelte-flavored if svelte — previous behavior.
  const format = ctx.svelte ? SVELTE_FORMAT : BASE_FORMAT;
  const lint = ctx.svelte ? SVELTE_LINT : BASE_LINT;
  return { format, lint, ...REPO_GLOBAL_SCRIPTS };
}

/** root-tier devDeps: repo-global tools + TS toolchain + @urbicon presets (everything except svelte). */
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

/** Version range parsing — top-level regexes (run per dependency inside loops). */
const WHITESPACE = /\s+/;
const SEMVER_TOKEN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const VERSION_RANGE = /^[v^~>=<\s]*\d/;
const SIMPLE_RANGE = /^([v^~>=]*)\d[\w.+-]*$/;

/**
 * Floor (lower bound) of a range: `^1.2.3`→`1.2.3`, `>=2.0.0 <3`→`2.0.0`, `<3 >=2`→`2.0.0`.
 * Upper bounds (`<…`) are skipped, so that compound ranges written in reverse order also yield
 * the actual floor (not accidentally the upper bound).
 */
function floorVersion(range: string): string | null {
  for (const token of range.trim().split(WHITESPACE)) {
    if (token.startsWith('<')) continue; // the upper bound is not the floor
    const m = token.match(SEMVER_TOKEN);
    if (m) return m[0];
  }
  return null;
}

/**
 * A pure version range (leading operators `v^~>=<`, then a digit)? Protocols like
 * `catalog:`/`workspace:`/`npm:`/`github:`/`git+…` start with a letter → `false`.
 */
function isVersionRange(s: string): boolean {
  return VERSION_RANGE.test(s);
}

/**
 * Raises `current` to at least `target` (floor comparison, semver-aware) — never a downgrade.
 * If `current` is already ≥ `target` (or not comparable: protocol, `*`), it stays unchanged
 * (build metadata/pre-release are preserved this way too). When raising, a simple single-token
 * range (`^`/`~`/`>=`/`v` + version) keeps its operator; a compound/exotic range is replaced by
 * the clean `target` instead of building a broken range. Foundation of catalog maintenance (D9-E);
 * related to the operator-preserving raise in `scripts/stack-update.ts` (there against the registry,
 * here against the udx pin).
 */
export function raise(current: string, target: string): string {
  const cf = floorVersion(current);
  const tf = floorVersion(target);
  if (cf === null || tf === null) return current; // not comparable → unchanged
  if (Bun.semver.order(cf, tf) >= 0) return current; // current ≥ target → no downgrade
  const simple = current.trim().match(SIMPLE_RANGE);
  return simple ? `${simple[1]}${tf}` : target;
}

/**
 * The pins in `versions.ts` are a **baseline** (minimum version), not an exact target value: if a
 * project already has a newer, compatible version, the pin is satisfied — udx raises projects to the
 * minimum but never lowers them (otherwise the @types/node downgrade would occur). Only a genuinely
 * older version counts as drift. Non-version specifiers (`workspace:`/`catalog:`/`npm:` alias,
 * git URL, `*`, …) govern the version elsewhere or point to a different package and count as
 * satisfied — downgrading something we cannot compare semantically would be dangerous.
 */
export function satisfiesPin(current: string, pin: string): boolean {
  // Only compare pure version ranges: protocols (`workspace:`/`catalog:`/`npm:`/`github:`/`git+…`)
  // start with a letter → count as satisfied (version governed elsewhere, never downgrade blindly).
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

/** Filter for the plan: `skip` removes building blocks (declined), `only` restricts (whitelist), `pinned` pins devDeps. */
export interface PkgFilter {
  skip?: PkgSet;
  only?: PkgSet;
  pinned?: ReadonlySet<string>;
}

export function computePkgPlan(
  ctx: ProjectContext,
  filter: PkgFilter = {},
  tier?: DepTier,
  /** The consumer's catalog tables (read by the caller from the root pkg); `null` ⇒ literal mode (D9-A). */
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
    // Intentionally pinned (`udx pin`) → leave untouched (no bump, no add, no catalog: switch),
    // but always report it — even if not installed — so an active pin never silently "disappears".
    // Comes BEFORE the catalog logic: a switch to `catalog:` would otherwise undercut the pin.
    if (pinned?.has(name)) {
      plan.devDepsPinned.push(
        current !== undefined ? { name, to: pin, from: current } : { name, to: pin }
      );
      continue;
    }

    // Predecessor name of this dep (RENAMED_FROM) still installed → remove it, the successor
    // is carried in this plan. Inside the loop so that --only/skip take effect automatically;
    // a `udx pin <old>` intentionally pins the old name (then no removal).
    const renamed = RENAMED_FROM[name as DepName];
    if (renamed && devDeps[renamed] !== undefined && !pinned?.has(renamed)) {
      plan.devDepsToRemove.push({ name: renamed, from: devDeps[renamed], to: name });
    }

    // Literal mode (no catalog) or @urbicon/* (unified with the CLI version, never bumped via
    // catalog/Renovate, D9-D) → previous behavior: add the literal version or raise it safely.
    if (catalog === null || URBICON_SET.has(name)) {
      if (current === undefined) plan.devDepsToAdd.push({ name, to: pin });
      else if (!satisfiesPin(current, pin))
        plan.devDepsDrift.push({ name, to: pin, from: current });
      continue;
    }

    // Catalog mode (D9): maintain the entry AND point the devDep at `catalog:`. Both arise in the
    // same plan so that WP3 writes them atomically — a `catalog:` without an entry breaks `bun install`.
    const pick = selectCatalogTable(catalog, name);
    const literal = current !== undefined && isVersionRange(current) ? current : undefined;
    if (pick.current === undefined) {
      // New entry: pin as the base, raised to a possibly higher literal devDep (never a downgrade, D9-E).
      plan.catalogEntriesToAdd.push({
        name,
        table: pick.table,
        to: literal ? raise(pin, literal) : pin
      });
    } else {
      // Existing entry: raise it if behind the pin or behind a literal devDep.
      let entry = pick.current;
      if (!satisfiesPin(pick.current, pin)) entry = raise(entry, pin);
      if (literal && !satisfiesPin(pick.current, literal)) entry = raise(entry, literal);
      if (entry !== pick.current)
        plan.catalogEntriesDrift.push({ name, table: pick.table, from: pick.current, to: entry });
    }
    // Point the devDep at the catalog reference (the entry is guaranteed present/planned by the above).
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
 * Applies the plan to the pkg object (scripts + devDeps of the respective package). Missing
 * scripts/devDeps, version drift, and the `catalog:` switch are always applied — `satisfiesPin`
 * guarantees that this is never a downgrade (the switch is covered by the catalog entry), so it
 * needs no `--force`. Only script drift may be an intentional adjustment → `--force`.
 * The catalog ENTRIES themselves are written into the root pkg by `applyCatalogEntries` (they only
 * live there). Returns true if something changed.
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
  // Safely raise versions lying behind the pin (never a downgrade) — without --force.
  for (const ch of plan.devDepsDrift) {
    devDeps[ch.name] = ch.to;
    changed = true;
  }
  // Catalog mode: switch a literal devDep to `catalog:`/`catalog:<name>` (entry covered by
  // applyCatalogEntries) — no downgrade, so without --force.
  for (const ch of plan.devDepsToCatalog) {
    devDeps[ch.name] = ch.to;
    changed = true;
  }
  // Old name of a renamed tool dep — the successor is guaranteed to be carried in the same plan
  // (same loop iteration), so it is safe without --force.
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
 * Records the plan's catalog entries (add + drift) into the mutable `catalog` working object.
 * This is shared across all package patches of a run, so the accumulation spans multiple Svelte
 * packages (D9-E): a second package sees the entry created/raised by the first and only raises it
 * further, instead of overwriting it. `wireCatalog` writes the result into the root pkg at the end.
 * Returns true if an entry was changed.
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
 * Wires the (possibly newly filled) catalog tables back into `rootPkg.workspaces` — Bun catalogs
 * live exclusively in the workspace root. If a table already points at the consumer object, this is
 * a no-op (same reference); a newly created default catalog is hooked in here. Empty tables are left
 * out so that no empty `catalog: {}` block is created.
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
