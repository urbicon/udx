# urbicon-udx (Claude plugin)

Bundles cross-project Claude Code skills & agents for the urbicon harness.

## Included

- **Skill `docs-review`** — review, consolidate, and align documentation with the
  code (size-dependent plan mode, archives instead of deleting, Lefthook-/
  git-cliff-aware).

## Installation

Register from the Codeberg repo as a marketplace and install the plugin:

```text
/plugin marketplace add https://codeberg.org/urbicon/udx
/plugin install urbicon-udx@urbicon
```

Locally (from a clone) for development:

```text
/plugin marketplace add <path-to-clone>
/plugin install urbicon-udx@urbicon
```

## Relationship to `~/.claude/skills`

This plugin is the **canonical, versioned home** of the skills. A copy
in `~/.claude/skills/` (on a single machine only) remains possible, but drifts easily —
through the plugin, updates are distributed via `git pull` / marketplace refresh.
