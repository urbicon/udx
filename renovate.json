{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "rangeStrategy": "bump",
  "semanticCommits": "enabled",
  "semanticCommitScope": "deps",
  "customManagers": [
    {
      "customType": "regex",
      "description": "Bun catalog (workspaces.catalog + catalogs.*): Renovate only knows pnpm/yarn catalogs natively, not Bun — so capture the version strings of the root package.json via regex (RE2). currentValue must start with ^/~, which excludes the version field (0.1.4) and catalog:/workspace: refs.",
      "fileMatch": ["^package\\.json$"],
      "matchStrings": [
        "\"(?<depName>@?[a-z0-9][\\w.\\-/]*)\"\\s*:\\s*\"(?<currentValue>[\\^~]\\d[\\w.\\-+]*)\""
      ],
      "datasourceTemplate": "npm"
    },
    {
      "customType": "regex",
      "description": "The biome.json $schema URL carries the exact Biome version. biome.json is create-only (udx sync does not pull it in), so track the version here like a dependency — otherwise Biome reports a schema mismatch after every bump. A separate manager, because the exact (^/~-less) version falls outside the catalog regex above.",
      "fileMatch": ["^biome\\.json$"],
      "matchStrings": [
        "https://biomejs\\.dev/schemas/(?<currentValue>\\d[\\w.\\-]*)/schema\\.json"
      ],
      "depNameTemplate": "@biomejs/biome",
      "datasourceTemplate": "npm"
    }
  ],
  "packageRules": [
    {
      "description": "The catalog is the single source of truth (incl. the biome.json $schema version) — updates bundled as one PR instead of scattered.",
      "matchFileNames": ["package.json", "biome.json"],
      "matchUpdateTypes": ["patch", "minor"],
      "groupName": "stack (catalog)"
    },
    {
      "description": "udx's own config packages are unified with the CLI version (scripts/bump.sh) — not to be bumped by Renovate.",
      "matchPackageNames": [
        "@urbicon-ui/biome-config",
        "@urbicon-ui/commitlint-config",
        "@urbicon-ui/tsconfig"
      ],
      "enabled": false
    }
  ]
}
