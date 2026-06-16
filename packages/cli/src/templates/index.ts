import bumpSh from '../assets/bump.sh' with { type: 'text' };
import claudeTpl from '../assets/CLAUDE.md.tpl' with { type: 'text' };
import cliffToml from '../assets/cliff.toml' with { type: 'text' };
// .tpl instead of .json: imported as text (not as a JSON module) and left unformatted by Biome,
// so the content stays byte-identical to the dogfooded root renovate.json (coupled via a test).
import renovateJson from '../assets/renovate.json.tpl' with { type: 'text' };
import { VERSIONS } from '../lib/versions.ts';

export interface RenderCtx {
  svelte: boolean;
  projectName: string;
  /**
   * Monorepo: true if ANY workspace package is svelte — even with a non-svelte root. Drives the
   * root-scoped Svelte building blocks (lefthook prettier line, `.prettierrc`/`.prettierignore`) that must
   * cover `.svelte` across all packages. If the field is missing (single-package / direct template use),
   * the decision falls back to `svelte`.
   */
  svelteAnywhere?: boolean;
}

/**
 * `managed`     – infra file; `udx sync` overwrites on drift.
 * `create-only` – only written when missing (user customizations stay).
 */
export type FilePolicy = 'managed' | 'create-only';

/**
 * `root`    – once in the project root (default).
 * `package` – per workspace package (in a monorepo); in a single-package project = root.
 */
export type FileScope = 'root' | 'package';

export interface FileTemplate {
  id: string;
  dest: string;
  policy: FilePolicy;
  scope?: FileScope;
  mode?: number;
  applies?: (ctx: RenderCtx) => boolean;
  render: (ctx: RenderCtx) => string;
}

// Derive the schema version from the pinned Biome version (one source of truth).
const BIOME_SCHEMA = `https://biomejs.dev/schemas/${VERSIONS['@biomejs/biome'].replace(/^[\^~]/, '')}/schema.json`;

function renderLefthook(ctx: RenderCtx): string {
  // root-scoped file: in a monorepo the one root hook formats `.svelte` from ALL packages, hence
  // svelteAnywhere instead of just ctx.svelte (which would be false for a non-svelte root → hook without the Svelte line).
  const sveltePrettier =
    (ctx.svelteAnywhere ?? ctx.svelte)
      ? `    prettier:
      glob: '*.svelte'
      run: bunx prettier --write {staged_files}
      stage_fixed: true
`
      : '';
  return `# Git hooks (managed by @urbicon/udx).
pre-commit:
  parallel: true
  commands:
    biome:
      glob: '*.{ts,js,mjs,cjs,json,jsonc}'
      run: bunx biome check --write --no-errors-on-unmatched --files-ignore-unknown=true {staged_files}
      stage_fixed: true
${sveltePrettier}
commit-msg:
  commands:
    commitlint:
      run: bunx --no -- commitlint --edit {1}
`;
}

function renderBiome(): string {
  // ALWAYS exclude `.svelte` — Biome doesn't process Svelte (Prettier + svelte-check handle that).
  // Even the non-svelte monorepo root needs the exclusion, otherwise `biome check .` trips over
  // `.svelte` in sub-packages. The CHANGELOG exclusion from biome-base must be repeated, since
  // `files.includes` overrides the base.
  const config: Record<string, unknown> = {
    $schema: BIOME_SCHEMA,
    extends: ['@urbicon/biome-config/biome-base.json'],
    files: { includes: ['**', '!**/*.svelte', '!**/CHANGELOG.md'] }
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function renderTsconfig(ctx: RenderCtx): string {
  const config = ctx.svelte
    ? {
        extends: ['@urbicon/tsconfig/svelte.json', './.svelte-kit/tsconfig.json'],
        compilerOptions: { baseUrl: '.' }
      }
    : {
        extends: '@urbicon/tsconfig/base.json',
        compilerOptions: { outDir: 'dist' },
        include: ['src']
      };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function renderCommitlint(): string {
  return `import { createConfig } from '@urbicon/commitlint-config';

export default createConfig({
  // Add project-specific scopes here, e.g. ['ui', 'api', 'core']:
  scopes: []
});
`;
}

function renderPrettierrc(): string {
  return `${JSON.stringify(
    {
      useTabs: false,
      singleQuote: true,
      trailingComma: 'none',
      printWidth: 100,
      plugins: ['prettier-plugin-svelte', 'prettier-plugin-tailwindcss'],
      overrides: [{ files: '*.svelte', options: { parser: 'svelte' } }]
    },
    null,
    2
  )}\n`;
}

function renderPrettierignore(): string {
  // gitignore semantics: a re-include (`!`) doesn't take effect below excluded
  // directories. `**/*` + `!**/*.svelte` would therefore let Prettier see ZERO files —
  // instead `*` + `!*/` (keep directories open) + `!*.svelte`.
  return `# Biome handles everything except .svelte.
*
!*/
!*.svelte
node_modules/
.svelte-kit/
build/
`;
}

function renderGitignore(): string {
  return `node_modules/
dist/
build/
.svelte-kit/
*.log
.DS_Store
.env
.env.*
!.env.example
`;
}

export const FILE_TEMPLATES: FileTemplate[] = [
  { id: 'cliff', dest: 'cliff.toml', policy: 'managed', render: () => cliffToml },
  { id: 'lefthook', dest: 'lefthook.yml', policy: 'managed', render: renderLefthook },
  { id: 'bump', dest: 'scripts/bump.sh', policy: 'managed', mode: 0o755, render: () => bumpSh },
  { id: 'biome', dest: 'biome.json', policy: 'create-only', render: renderBiome },
  // package-scoped: in a monorepo per package (the root tsconfig stays project-specific, untouched).
  {
    id: 'tsconfig',
    dest: 'tsconfig.json',
    policy: 'create-only',
    scope: 'package',
    render: renderTsconfig
  },
  {
    id: 'commitlint',
    dest: 'commitlint.config.mjs',
    policy: 'create-only',
    render: renderCommitlint
  },
  {
    id: 'prettierrc',
    dest: '.prettierrc',
    policy: 'create-only',
    applies: (ctx) => ctx.svelteAnywhere ?? ctx.svelte,
    render: renderPrettierrc
  },
  {
    id: 'prettierignore',
    dest: '.prettierignore',
    policy: 'create-only',
    applies: (ctx) => ctx.svelteAnywhere ?? ctx.svelte,
    render: renderPrettierignore
  },
  { id: 'gitignore', dest: '.gitignore', policy: 'create-only', render: renderGitignore },
  // create-only: schedules/packageRules are project-specific — updates to the building block
  // deliberately don't reach existing projects automatically (own Renovate configs stay untouched).
  { id: 'renovate', dest: 'renovate.json', policy: 'create-only', render: () => renovateJson },
  {
    id: 'claude',
    dest: 'CLAUDE.md',
    policy: 'create-only',
    render: (ctx) => claudeTpl.replaceAll('{{projectName}}', ctx.projectName)
  }
];

// Invariant (fail-fast instead of silent corruption): package-scoped building blocks run per package
// but share the one `.udx.json` with hash keys named after `dest`. A managed package building block
// would overwrite these across packages — hence only create-only is permitted.
for (const t of FILE_TEMPLATES) {
  if (t.scope === 'package' && t.policy !== 'create-only') {
    throw new Error(
      `FILE_TEMPLATES: package-scoped building block '${t.id}' must be create-only (manifest hash collision).`
    );
  }
}
