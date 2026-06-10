import bumpSh from '../assets/bump.sh' with { type: 'text' };
import claudeTpl from '../assets/CLAUDE.md.tpl' with { type: 'text' };
import cliffToml from '../assets/cliff.toml' with { type: 'text' };
// .tpl statt .json: als Text importiert (nicht als JSON-Modul) und von Biome unformatiert,
// damit der Inhalt byte-identisch zur dogfooded Root-renovate.json bleibt (per Test gekoppelt).
import renovateJson from '../assets/renovate.json.tpl' with { type: 'text' };
import { VERSIONS } from '../lib/versions.ts';

export interface RenderCtx {
  svelte: boolean;
  projectName: string;
}

/**
 * `managed`     – Infra-Datei; `udx sync` überschreibt bei Drift.
 * `create-only` – wird nur geschrieben, wenn sie fehlt (Nutzer-Anpassungen bleiben).
 */
export type FilePolicy = 'managed' | 'create-only';

/**
 * `root`    – einmal im Projekt-Root (Default).
 * `package` – pro Workspace-Paket (im Monorepo); im Single-Package-Projekt = Root.
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

// Schema-Version aus der gepinnten Biome-Version ableiten (eine Wahrheitsquelle).
const BIOME_SCHEMA = `https://biomejs.dev/schemas/${VERSIONS['@biomejs/biome'].replace(/^[\^~]/, '')}/schema.json`;

function renderLefthook(ctx: RenderCtx): string {
  const sveltePrettier = ctx.svelte
    ? `    prettier:
      glob: '*.svelte'
      run: bunx prettier --write {staged_files}
      stage_fixed: true
`
    : '';
  return `# Git-Hooks (verwaltet von @urbicon/udx).
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
  // `.svelte` IMMER ausschließen — Biome verarbeitet Svelte nicht (das übernehmen Prettier +
  // svelte-check). Auch der nicht-svelte Monorepo-Root braucht den Ausschluss, sonst stolpert
  // `biome check .` über `.svelte` in Sub-Paketen. Der CHANGELOG-Ausschluss aus biome-base muss
  // wiederholt werden, da `files.includes` das Base überschreibt.
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
  // Projektspezifische Scopes hier ergänzen, z. B. ['ui', 'api', 'core']:
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
  // gitignore-Semantik: ein Re-Include (`!`) greift nicht unterhalb ausgeschlossener
  // Verzeichnisse. `**/*` + `!**/*.svelte` ließe Prettier daher NULL Dateien sehen —
  // stattdessen `*` + `!*/` (Verzeichnisse offen halten) + `!*.svelte`.
  return `# Biome ist für alles außer .svelte zuständig.
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
  // package-scoped: im Monorepo je Paket (Root-tsconfig bleibt projektspezifisch unberührt).
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
    applies: (ctx) => ctx.svelte,
    render: renderPrettierrc
  },
  {
    id: 'prettierignore',
    dest: '.prettierignore',
    policy: 'create-only',
    applies: (ctx) => ctx.svelte,
    render: renderPrettierignore
  },
  { id: 'gitignore', dest: '.gitignore', policy: 'create-only', render: renderGitignore },
  // create-only: Schedules/packageRules sind projektspezifisch — Updates am Baustein erreichen
  // Bestandsprojekte bewusst nicht automatisch (eigene Renovate-Configs bleiben unangetastet).
  { id: 'renovate', dest: 'renovate.json', policy: 'create-only', render: () => renovateJson },
  {
    id: 'claude',
    dest: 'CLAUDE.md',
    policy: 'create-only',
    render: (ctx) => claudeTpl.replaceAll('{{projectName}}', ctx.projectName)
  }
];

// Invariante (fail-fast statt stiller Korruption): package-scoped Bausteine laufen je Paket,
// teilen sich aber das eine `.udx.json` mit nach `dest` benannten Hash-Schlüsseln. Ein managed
// package-Baustein würde diese über Pakete hinweg überschreiben — daher nur create-only zulässig.
for (const t of FILE_TEMPLATES) {
  if (t.scope === 'package' && t.policy !== 'create-only') {
    throw new Error(
      `FILE_TEMPLATES: package-scoped Baustein '${t.id}' muss create-only sein (Manifest-Hash-Kollision).`
    );
  }
}
