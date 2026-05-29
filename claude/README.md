# urbicon-udx (Claude-Plugin)

Bündelt projektübergreifende Claude-Code-Skills & Agents für das urbicon-Harness.

## Enthalten

- **Skill `docs-review`** — Dokumentation prüfen, konsolidieren und mit dem Code
  abgleichen (größenabhängiger Plan-Modus, archiviert statt löscht, Lefthook-/
  git-cliff-bewusst).

## Installation

Aus dem Codeberg-Repo als Marketplace registrieren und Plugin installieren:

```text
/plugin marketplace add https://codeberg.org/urbicon/udx
/plugin install urbicon-udx@urbicon
```

Lokal (aus einem Klon) zum Entwickeln:

```text
/plugin marketplace add /Users/felix/Workspace/udx
/plugin install urbicon-udx@urbicon
```

## Verhältnis zu `~/.claude/skills`

Dieses Plugin ist die **kanonische, versionierte Heimat** der Skills. Eine Kopie
in `~/.claude/skills/` (nur auf einem Rechner) bleibt möglich, driftet aber leicht —
über das Plugin werden Updates per `git pull` / Marketplace-Refresh verteilt.
