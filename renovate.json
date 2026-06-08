{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "rangeStrategy": "bump",
  "semanticCommits": "enabled",
  "semanticCommitScope": "deps",
  "customManagers": [
    {
      "customType": "regex",
      "description": "Bun-Catalog (workspaces.catalog + catalogs.*): Renovate kennt nur pnpm/yarn-Catalogs nativ, nicht Bun — daher die Versions-Strings der Root-package.json per Regex (RE2) erfassen. currentValue muss mit ^/~ beginnen, das schließt das version-Feld (0.1.4) und catalog:/workspace:-Refs aus.",
      "fileMatch": ["^package\\.json$"],
      "matchStrings": [
        "\"(?<depName>@?[a-z0-9][\\w.\\-/]*)\"\\s*:\\s*\"(?<currentValue>[\\^~]\\d[\\w.\\-+]*)\""
      ],
      "datasourceTemplate": "npm"
    }
  ],
  "packageRules": [
    {
      "description": "Catalog ist die Single Source of Truth — Updates gebündelt als ein PR statt verstreut.",
      "matchFileNames": ["package.json"],
      "matchUpdateTypes": ["patch", "minor"],
      "groupName": "stack (catalog)"
    },
    {
      "description": "udx-eigene Config-Pakete sind unified mit der CLI-Version (scripts/bump.sh) — nicht von Renovate anheben.",
      "matchPackageNames": [
        "@urbicon/biome-config",
        "@urbicon/commitlint-config",
        "@urbicon/tsconfig"
      ],
      "enabled": false
    }
  ]
}
