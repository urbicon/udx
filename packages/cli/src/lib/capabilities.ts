import type { ProjectContext } from './detect.ts';
import { abs, exists } from './fs.ts';
import type { Manifest } from './manifest.ts';
import type { DepName } from './versions.ts';

/**
 * A declinable stack capability that bundles file(s), scripts, and devDeps.
 * `supersededBy` detects generically (via deps/files, never via project names) whether the
 * project already solves this capability differently — in which case the building block is
 * automatically declined and the decision is persisted in the manifest.
 */
export interface Capability {
  id: string;
  label: string;
  /** Referenced FILE_TEMPLATE ids (loosely coupled by string, guarded by a test). */
  files: string[];
  /** Referenced canonicalScripts keys. */
  scripts: string[];
  devDeps: DepName[];
  /** Detected competing tool (e.g. `husky`) or `null` if the building block applies. */
  supersededBy: (ctx: ProjectContext) => string | null;
}

function hasDep(ctx: ProjectContext, name: string): boolean {
  return Boolean(ctx.pkg.dependencies?.[name] ?? ctx.pkg.devDependencies?.[name]);
}

function hasPath(ctx: ProjectContext, rel: string): boolean {
  return exists(abs(ctx.cwd, rel));
}

export const CAPABILITIES: Capability[] = [
  {
    id: 'git-hooks',
    label: 'Git hooks (lefthook)',
    files: ['lefthook'],
    scripts: ['prepare'],
    devDeps: ['lefthook'],
    supersededBy: (ctx) => {
      if (hasDep(ctx, 'husky') || hasPath(ctx, '.husky')) return 'husky';
      if (hasDep(ctx, 'simple-git-hooks')) return 'simple-git-hooks';
      // Hooks without a tool: a .githooks directory or a setup script that sets core.hooksPath
      // (typically `"prepare": "git config core.hooksPath .githooks"`). Lefthook would overwrite
      // the prepare script and disable the existing hooks — so decline it.
      const setup = `${ctx.pkg.scripts?.prepare ?? ''} ${ctx.pkg.scripts?.postinstall ?? ''}`;
      if (hasPath(ctx, '.githooks') || setup.includes('core.hooksPath')) return 'core.hooksPath';
      return null;
    }
  },
  {
    id: 'lint-format',
    label: 'Lint/Format (biome)',
    files: ['biome'],
    scripts: ['lint', 'format', 'fix'],
    // Biome core + the svelte-specific lint/format chain. `prettier` itself is intentionally
    // left out: it is shared with the git-hooks Prettier hook (otherwise a gap the other way).
    // For non-Svelte projects the svelte deps are absent from the plan anyway — the skip set
    // then comes to nothing (harmless).
    devDeps: [
      '@biomejs/biome',
      '@urbicon/biome-config',
      'prettier-plugin-svelte',
      'prettier-plugin-tailwindcss',
      'svelte-check'
    ],
    supersededBy: (ctx) => (hasDep(ctx, 'eslint') ? 'eslint' : null)
  },
  {
    id: 'dep-updates',
    label: 'Dependency updates (renovate)',
    files: ['renovate'],
    scripts: [],
    devDeps: [],
    supersededBy: (ctx) => {
      if (hasPath(ctx, '.github/dependabot.yml') || hasPath(ctx, '.github/dependabot.yaml')) {
        return 'dependabot';
      }
      // Renovate is already configured, just in one of the alternative locations — don't place
      // anything alongside (a renovate.json in the root is covered by create-only anyway).
      const elsewhere = [
        'renovate.json5',
        '.renovaterc',
        '.renovaterc.json',
        '.renovaterc.json5',
        '.github/renovate.json',
        '.github/renovate.json5'
      ];
      if (elsewhere.some((p) => hasPath(ctx, p)) || ctx.pkg.renovate !== undefined) {
        return 'renovate (own config)';
      }
      return null;
    }
  }
];

export function findCapability(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

export interface CapabilityState {
  cap: Capability;
  declined: boolean;
  /** Reason for declining (detected tool or `manual`); empty when active. */
  reason: string;
  /** Detected for the first time in this run — not yet persisted in the manifest. */
  fresh: boolean;
  /** Auto-declined, but the tool detected back then is no longer present (reason is stale). */
  stale: boolean;
}

/**
 * Determines the state per capability. Pure (mutates nothing). Priority:
 * `adopted` (explicitly active, overrides any auto-decline) → `declined` (noted in the manifest)
 * → `supersededBy` (fresh auto-decline, `fresh`). The caller persists fresh declines
 * (init/sync) or only displays them (doctor). A persisted auto-decline whose tool has
 * disappeared is marked `stale` (doctor points this out).
 */
export function resolveCapabilities(ctx: ProjectContext, manifest: Manifest): CapabilityState[] {
  return CAPABILITIES.map((cap) => {
    if (manifest.adopted.includes(cap.id)) {
      return { cap, declined: false, reason: '', fresh: false, stale: false };
    }
    const persisted = manifest.declined[cap.id];
    if (persisted !== undefined) {
      // 'manual' is an intentional choice and never stale; a tool reason is, when it is missing.
      const stale = persisted !== 'manual' && cap.supersededBy(ctx) === null;
      return { cap, declined: true, reason: persisted, fresh: false, stale };
    }
    const tool = cap.supersededBy(ctx);
    if (tool) return { cap, declined: true, reason: tool, fresh: true, stale: false };
    return { cap, declined: false, reason: '', fresh: false, stale: false };
  });
}

export interface DeclinedSets {
  /** Declined FILE_TEMPLATE id → reason. */
  files: Map<string, string>;
  scripts: Set<string>;
  devDeps: Set<string>;
}

/** Folds the declined capabilities into skip sets for apply/pkg/doctor. */
export function declinedSets(states: CapabilityState[]): DeclinedSets {
  const files = new Map<string, string>();
  const scripts = new Set<string>();
  const devDeps = new Set<string>();
  for (const s of states) {
    if (!s.declined) continue;
    for (const f of s.cap.files) files.set(f, s.reason);
    for (const sc of s.cap.scripts) scripts.add(sc);
    for (const d of s.cap.devDeps) devDeps.add(d);
  }
  return { files, scripts, devDeps };
}

export interface Selection {
  /** Selected FILE_TEMPLATE ids. */
  files: Set<string>;
  scripts: Set<string>;
  devDeps: Set<string>;
  /** Identifiers that are neither a capability nor a file. */
  unknown: string[];
}

/**
 * Resolves `--only` identifiers to concrete building blocks. An identifier is either a
 * capability id (expanded to its file/scripts/devDeps) or a FILE_TEMPLATE id.
 * `validFileIds` comes from the caller, so the lib stays decoupled from the templates.
 */
export function resolveSelection(ids: string[], validFileIds: ReadonlySet<string>): Selection {
  const sel: Selection = { files: new Set(), scripts: new Set(), devDeps: new Set(), unknown: [] };
  for (const id of ids) {
    const cap = findCapability(id);
    if (cap) {
      for (const f of cap.files) sel.files.add(f);
      for (const s of cap.scripts) sel.scripts.add(s);
      for (const d of cap.devDeps) sel.devDeps.add(d);
    } else if (validFileIds.has(id)) {
      sel.files.add(id);
    } else {
      sel.unknown.push(id);
    }
  }
  return sel;
}
