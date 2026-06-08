import { c } from '../lib/colors.ts';

/**
 * Vollständige `--help`-Ausgabe. Die Version kommt als Parameter (statt package.json hier zu
 * importieren), damit die Hilfe ohne Seiteneffekte und versionsstabil im Test snapshotbar ist.
 *
 * Naming (D7): Dev-facing sind `init·status·sync·add·remove` (+ `pin/unpin`); `adopt`/`skip`/
 * `doctor` bleiben als Aliase erhalten, erscheinen aber nur in der Fußnote, nicht in der
 * Befehlstabelle.
 */
export function helpText(version: string): string {
  return `${c.bold('udx')} — urbicon-Entwicklungs-Harness  ${c.gray(`v${version}`)}

${c.bold('Verwendung')}
  udx <befehl> [optionen]

${c.bold('Befehle')}
  init           Harness in ein Projekt einrichten (Configs, Hooks, Scripts, devDeps)
  status         Ist-Zustand: was ist da, was würde ein sync ändern und wie (Default ohne Befehl)
  sync           Verwaltete Dateien & devDeps aktualisieren (Verbesserungen nachziehen)
  add <id>       Baustein aufnehmen und direkt einrichten (z. B. git-hooks, lint-format)
  remove <id>    Baustein nicht mehr verwalten (vorhandene Dateien bleiben)
  pin <dep> [r]  devDep-Version bewusst halten — \`sync\` zieht sie nicht hoch
  unpin <dep>    Halten wieder aufheben

${c.bold('Optionen')}
  -n, --dry-run     nichts schreiben, nur anzeigen
  -f, --force       auch lokal geänderte Dateien & package.json-Drift überschreiben
  -i, --interactive bei Konflikten pro Datei entscheiden (update/skip/diff)
      --only <ids>  nur diese Bausteine (Baustein- oder Datei-Ids, kommasepariert)
      --diff        bei Drift den Unterschied lokal → Vorgabe anzeigen
      --json        (status) strukturierte Ausgabe für Tooling
      --svelte      Svelte-Setup erzwingen (statt Auto-Erkennung)
      --no-svelte   reines TS-Setup erzwingen
      --cwd <pfad>  Zielverzeichnis (Default: aktuelles)
  -h, --help        diese Hilfe
  -V, --version     Version

${c.bold('Beispiele')}
  udx                       ${c.gray('# Status: was ist da, was würde ein sync ändern')}
  udx init                  ${c.gray('# neues/bestehendes Projekt einrichten')}
  udx sync --dry-run --diff ${c.gray('# Vorschau samt Diff, was ein Update ändern würde')}
  udx add git-hooks         ${c.gray('# lefthook aufnehmen und einrichten')}
  udx remove git-hooks      ${c.gray('# lefthook nicht mehr verwalten (eigener Hook-Stack)')}

${c.gray('Aliase  doctor — status mit Exit-Code für CI · adopt/skip — nur auf-/abwählen (add richtet zusätzlich ein)')}
`;
}
