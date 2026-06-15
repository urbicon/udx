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
    },
    {
      "customType": "regex",
      "description": "biome.json $schema-URL trägt die exakte biome-Version. biome.json ist create-only (udx sync zieht sie nicht nach), darum die Version hier wie eine Dependency mitführen — sonst meldet biome nach jedem Bump einen Schema-Mismatch. Eigener Manager, weil die exakte (^/~-lose) Version aus dem Catalog-Regex oben herausfällt.",
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
      "description": "Catalog ist die Single Source of Truth (inkl. der biome.json-$schema-Version) — Updates gebündelt als ein PR statt verstreut.",
      "matchFileNames": ["package.json", "biome.json"],
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
