import bumpSh from '../assets/bump.sh' with { type: 'text' };
import claudeTpl from '../assets/CLAUDE.md.tpl' with { type: 'text' };
import cliffToml from '../assets/cliff.toml' with { type: 'text' };

export interface RenderCtx {
  svelte: boolean;
  projectName: string;
}

/**
 * `managed`     – Infra-Datei; `udx sync` überschreibt bei Drift.
 * `create-only` – wird nur geschrieben, wenn sie fehlt (Nutzer-Anpassungen bleiben).
 */
export type FilePolicy = 'managed' | 'create-only';

export interface FileTemplate {
  id: string;
  dest: string;
  policy: FilePolicy;
  mode?: number;
  applies?: (ctx: RenderCtx) => boolean;
  render: (ctx: RenderCtx) => string;
}

const BIOME_SCHEMA = 'https://biomejs.dev/schemas/2.4.16/schema.json';

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

function renderBiome(ctx: RenderCtx): string {
  const config: Record<string, unknown> = {
    $schema: BIOME_SCHEMA,
    extends: ['@urbicon/biome-config/biome-base.json']
  };
  if (ctx.svelte) {
    // .svelte übernimmt Prettier; alles andere Biome. Der CHANGELOG-Ausschluss aus
    // biome-base muss hier wiederholt werden, da files.includes das Base überschreibt.
    config.files = { includes: ['**', '!**/*.svelte', '!**/CHANGELOG.md'] };
  }
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
  return `# Biome ist für alles außer .svelte zuständig.
**/*
!**/*.svelte
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
  { id: 'tsconfig', dest: 'tsconfig.json', policy: 'create-only', render: renderTsconfig },
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
  {
    id: 'claude',
    dest: 'CLAUDE.md',
    policy: 'create-only',
    render: (ctx) => claudeTpl.replaceAll('{{projectName}}', ctx.projectName)
  }
];
