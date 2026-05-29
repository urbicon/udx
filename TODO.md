# Harness-Review — ToDo

Tracking der Befunde aus dem vollständigen Projekt-Review (2026-05-29) plus drei
Zusatzpunkten (Bun-Bundler, Codeberg-Bezug, bunfig.toml-Migration).

**Branch:** `chore/harness-review-fixes` · **Stand:** 2026-05-30
**Status-Legende:** `[ ]` offen · `[x]` erledigt · `[~]` teilweise (Rest = Nutzer-Aktion)

> **Ergebnis:** Alle Code- und Doku-Punkte sind umgesetzt und verifiziert (24 Tests,
> Build/Lint/Typecheck grün, E2E `init`/`sync`/`doctor` sauber). Offen bleiben nur
> Aktionen, die einen `CODEBERG_TOKEN` bzw. eine Strategie-Entscheidung brauchen — siehe unten.

---

## A · Distribution & Veröffentlichung

- [x] **A1 — `@commitlint/types` als dependency** + echter `tsc`-Check _(fix(commitlint-config))_
- [x] **A2 — `prepublishOnly` in `packages/cli`** _(build(cli))_
- [x] **A3 — Veraltete Version im Build** — durch A2 (frischer Build vor Publish) gelöst
- [~] **A4 — Codeberg-Bezug / Publish** — Diagnose + Vorbereitung erledigt; **Publish = Nutzer-Aktion**
  - Diagnose: Repo privat, SSH-Zugriff ok, **nichts publiziert** (keine Tags), `CODEBERG_TOKEN` nicht gesetzt.
  - Vorbereitet: bunfig.toml mit Token (Lesen+Publizieren), Publish-Workflow + Erst-Bootstrap im README.
  - **Offen:** Pakete tatsächlich publizieren (braucht Token — siehe „Verbleibende Aktionen").
- [x] **A5 — `versions.ts` synchron zu Releases** — `@urbicon`-Pins aus eigener Version abgeleitet _(fix(cli))_

## B · bunfig.toml-Migration

- [x] **B1 — Repo-`.npmrc` → `bunfig.toml`** _(feat(cli))_
- [x] **B2 — `ensureNpmrc` → `ensureBunfig`** (apply/harness/doctor) _(feat(cli))_
- [x] **B3 — Token-Zeile** (`$CODEBERG_TOKEN`, privates Repo) _(feat(cli))_
- [x] **B4 — Docs** (README, CLI-README, CLAUDE.md, tsconfig-README) _(docs)_
- [x] **B5 — `.gitignore`**: bunfig.toml committet, `.env` (Token) ignoriert

## C · Dogfooding-Konsistenz

- [x] **C1 — CHANGELOG-Ausschluss** in `biome-base.json` zentralisiert (+ Svelte-Override) _(feat(biome-config))_
- [x] **C2 — `bun.lock` committet** _(chore)_

## D · Code-Qualität

- [x] **D1 — Tote Felder** `isMonorepo`/`hasPackageJson` entfernt _(refactor(cli))_
- [x] **D2 — Doppelter `detectContext`** beseitigt _(refactor(cli))_
- [x] **D3 — Echter Check** für `commitlint-config` _(fix(commitlint-config))_
- [x] **D4 — Biome-Schema** aus `versions.ts` abgeleitet _(refactor(cli))_

## E · Bun-Bundler & moderne Features

- [x] **E1 — `--minify --sourcemap=linked`** (Bundle −24 %) _(build(cli))_
- [x] **E2 — `with { type: 'text'/'json' }`** validiert — korrekt
- [x] **E3 — `bump.sh` bun-nativ** (kein node/npm mehr) _(refactor(cli))_

## F · Doku & Kleinkram

- [x] **F1 — Hartcodierter Pfad** → `<pfad-zum-klon>` _(docs)_
- [x] **F2 — Footer** „lefthook install" entfernt (prepare deckt es ab) _(fix(cli))_
- [x] **F3 — Lese-Auth dokumentiert** (Token im Footer + README) _(fix(cli)/docs)_

## G · Tests

- [x] **G1 — Tests**: mutatePkg, ensureBunfig (alle Pfade), `--force`, unified-versioning. 12 → 24 _(test(cli))_

---

## Verbleibende Aktionen (brauchen dich / einen Token)

1. **Pakete publizieren** (schließt A4 ab). Mit gesetztem `CODEBERG_TOKEN`:
   ```bash
   bun run bump                              # Version + Changelog + Tag
   ( cd packages/tsconfig          && bun publish )
   ( cd packages/biome-config      && bun publish )
   ( cd packages/commitlint-config && bun publish )
   ( cd packages/cli               && bun publish )   # prepublishOnly baut dist/
   git push --follow-tags
   ```
   Danach `bunx @urbicon/udx init` in einem Fremdprojekt testen (verifiziert Lese-Auth
   der privaten Registry). Ich kann nicht publizieren — SSH-Key ≠ Registry-Token.

## Offene Entscheidungen

1. **Registry-Sichtbarkeit:** umgesetzt als **privat + Token** (Repo ist privat). Falls die
   Pakete öffentlich lesbar sein sollen, kann die Token-Zeile entfallen — sag Bescheid.
2. **Publish-Mechanik:** aktuell manuell dokumentiert. CI-Workflow (Codeberg Actions) gewünscht?
3. **Verdaccio-Fallback:** nur als Option notiert. Soll ich einen Verdaccio-Pfad (eigene Registry-URL
   in bunfig.toml/`publishConfig`) konkret vorbereiten?
