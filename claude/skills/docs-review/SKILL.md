---
name: docs-review
description: Review, consolidate, and align project documentation (Markdown files, READMEs, CLAUDE.md, AGENTS.md) with the current codebase. Use this skill whenever the user asks to review, audit, clean up, refactor, consolidate, or prune documentation — including phrasings like "docs review", "docs-review", "clean up the docs", "revise documentation", "update the docs", "check if docs are still accurate", "archive old docs", or "consolidate the documentation". Also trigger when the user mentions stale or obsolete markdown files, completed TODO/analysis documents, doc-code inconsistencies, or wants to restructure a docs/ folder. The skill performs a scoped analysis, produces a review plan for approval, then executes updates, merges, archives, and deletions in a knowledge-preserving order.
---

# docs-review

Systematically review and maintain Markdown documentation across a workspace so it stays aligned with the codebase, free of obsolete clutter, and structured for actual use.

## Core principle

**Analyze fully, plan explicitly, execute atomically, preserve knowledge.**

Never delete a document before extracting and merging any still-useful content from it into its target location. Do the full analysis and produce a plan file *before* touching any documentation.

## Workflow

Four phases, always in this order:

1. **Scope & analyze** — determine what's in scope, read everything, classify every document
2. **Plan** — present the plan for review (inline via plan mode for small reviews; as an editable plan file for large ones — see Phase 2)
3. **Approve** — wait for the user's go-ahead (or adjustments)
4. **Execute** — apply changes in the safe order defined below

Do not merge phases. In particular, do not start making changes while still analyzing.

The git commits produced in Phase 4 are the audit trail — not any plan file. A plan file, when written, is a working artifact for review; it is preserved by archiving, never by being left as loose clutter or deleted.

---

## Phase 1: Scope & analyze

### Determine scope

The user typically names a docs folder (most often `/docs`) or a repo root. Additional rules:

- Include `.md` files everywhere in the given scope: root-level files (`README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, etc.), nested `docs/` folders, package-level docs in monorepos.
- Default scope is workspace-wide. If the repo is a monorepo (e.g. has `packages/`, `apps/`, workspace configs in `package.json` / `pnpm-workspace.yaml` / `bun`), include docs in every package unless the user limited scope.
- No default ignore list. If the user wants exclusions, they say so — or a `.docs-review-ignore` file in the repo root with gitignore-style patterns is honored if present.
- **Handle with extra care** (flag in plan rather than auto-modify): `CHANGELOG.md`, `LICENSE`, `LICENCE`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, legal notices. These have conventions the user may not want disturbed.

### Pre-flight check (mandatory)

Before reading docs, run:

```bash
git status
git rev-parse --abbrev-ref HEAD
```

If the working tree is dirty, tell the user and ask whether to stash, commit, or abort. Do not proceed on a dirty tree — changes from this skill must be isolated and reviewable.

If already on `main` / `master` / `develop`, propose creating a branch like `docs/review-YYYY-MM-DD` and wait for confirmation. On a feature branch, it's fine to continue on it, but still say so.

### Read everything in scope

Read every in-scope `.md` fully. Do not skim based on filename.

For each document, extract:

- **Topic & purpose** (as stated by the doc itself)
- **References to code**: file paths, module names, function/class names, CLI commands, env variables, config keys, API endpoints, package names, URLs into the repo
- **Status markers**: completed checkboxes, "TODO", "WIP", "DONE", "deprecated", dates, version numbers, "resolved", "abgeschlossen", "erledigt"
- **Cross-references**: links to other docs in the repo
- **Last meaningful edit** (via `git log -1 --format=%ai -- <file>`) — use as a signal, not a verdict

### Code-vs-doc consistency checks

For every code reference found in a doc, verify against the current codebase:

- **File paths & module names**: does the path still exist? (`test -e` or equivalent)
- **Function / class / export names**: grep the codebase — still defined?
- **CLI commands**: does the command exist in `package.json` scripts, `justfile`, `Makefile`, or binaries?
- **Env variables**: are they still referenced in `.env.example`, config loaders, or source?
- **API endpoints / routes**: grep for the route string in source
- **Dependencies**: does the doc mention libraries no longer in `package.json` / `Cargo.toml` / `pyproject.toml`?
- **Config keys**: do they still exist in the relevant schema / types?

Every mismatch is a finding with a proposed fix (update the doc, or the reference is genuinely obsolete — which may mean the whole doc or section is obsolete).

### Classify each document

Assign exactly one primary action per document:

- **keep** — accurate and useful as-is
- **update** — content is relevant but has factual drift from code (specific fixes listed)
- **compress** — long, only parts still relevant; shortened version proposed
- **merge-then-archive** — content worth preserving should be folded into another doc, then the original archived
- **merge-then-delete** — content worth preserving should be folded into another doc, then the original deleted
- **archive** — historical value but no longer operationally relevant (completed analyses, retrospectives)
- **delete** — obsolete, superseded, no residual value (e.g. a `TODO.md` fully checked off months ago with no insights left)
- **restructure** — move/rename/split/combine, with the new location specified

`restructure` may combine with another action for the same file.

### Cross-cutting analysis

Beyond individual docs, identify:

- **Duplicates & overlap**: multiple docs covering the same ground (propose a canonical doc and what to merge where)
- **Gaps**: code areas or concepts heavily referenced but never explained
- **Structural issues**: docs in wrong locations, inconsistent naming, missing indexes/READMEs in docs folders, flat folders that should be nested (or vice versa), inconsistent heading hierarchies
- **Dead internal links** (pre-existing, before any changes)
- **Navigation**: is there a clear entry point? Does a top-level `docs/README.md` or index exist and cover actual contents?

---

## Phase 2: Present the plan

How the plan is surfaced depends on the size of the review:

- **Small / medium reviews** (roughly ≤ 10 files touched, no major restructure): use native **plan mode** — `EnterPlanMode` while analyzing, `ExitPlanMode` to present the plan and gate approval. Present the plan inline; do **not** write a plan file. There is then no artifact to clean up afterward.
- **Large reviews or structural reorganizations** (many files, moves/renames, multi-doc merges): write the plan to `docs-review-plan.md` at the root of the scope (repo root unless the user specified otherwise). A long, granular plan is far easier to review and edit as a file than inline. This file is **not** deleted afterward — it is archived alongside the docs it touched in Phase 4 (see "Archive the plan").

Either way the plan content is structured the same.

### Plan structure

```markdown
# Docs Review Plan — <scope> — YYYY-MM-DD

## Summary
- N files reviewed
- Actions: X keep, X update, X compress, X merge, X archive, X delete, X restructure
- Git branch: <branch-name>

## Cross-cutting changes
- Structural moves, duplicate consolidations, new index files
- Dead-link repairs (separate section; listed here so they're visible)

## Per-file actions
### <path/to/file.md>
- **Action**: update
- **Reason**: References `src/lib/old-name.ts` (renamed to `src/lib/renamed.ts`), mentions `bun run old-cmd` (no longer in package.json)
- **Changes**:
  - Line 23: update path
  - Line 45–52: rewrite example block
- **Confidence**: high / medium / low

### <path/to/another.md>
- **Action**: merge-then-archive
- **Target**: `docs/architecture.md` (append to "Historical decisions" section)
- **Content to preserve**: rationale for auth choice (section "Why JWT over sessions")
- **Archive location**: `docs/archive/2026-04/another.md`
- **Confidence**: high

## Flagged for your review
(Items where the skill is uncertain or files it was told to handle with care.)
- `CHANGELOG.md` — appears to contain duplicate entries for v0.3.0; leaving untouched, recommend manual check.
```

### Plan-writing rules

- Every destructive action (delete, archive, move, overwrite) must be listed explicitly with its target path.
- Every `update` must list the specific changes, not "fix inconsistencies".
- Confidence levels: **high** = mechanical/obvious, **medium** = judgment call but well-reasoned, **low** = the user should decide.
- Low-confidence items go under "Flagged for your review" and are *not* executed automatically.
- If the plan would touch more than ~50 files, consider asking the user to narrow scope before writing it out in full.

### Hand-off to the user

After preparing the plan, stop and show the user: summary counts and anything flagged. For a file-based plan, give the plan file path and invite them to edit it directly; for an inline plan, present it via `ExitPlanMode`. Ask them to approve, adjust, or request changes.

---

## Phase 3: Approval

Wait for explicit user go-ahead. Accept:

- "Ok, proceed" / "mach" / "los" → execute the whole plan
- "Proceed but skip X" → execute everything except X
- Direct edits to `docs-review-plan.md` (file-based plans) → re-read the edited plan and execute that version
- Questions → answer, then re-prompt

If the user asks for modifications before approval and a plan file exists, revise the file (don't just discuss verbally) so there's always a single source of truth. For inline (plan-mode) reviews, restate the adjusted plan before re-requesting approval.

---

## Phase 4: Execute

### Execution order (do not deviate)

This order exists to prevent knowledge loss and broken intermediate states. Always apply the steps in this sequence; **how many commits you make is a separate decision** (see "Commit granularity"):

1. **Merge content first.** For every `merge-then-archive` and `merge-then-delete`: extract the to-preserve content and integrate it into the target doc.
2. **Updates to existing docs.** Apply `update` and `compress` actions.
3. **Structural changes.** Moves, renames, new index files, directory reorgs. Use `git mv` so history is preserved.
4. **Link repair.** Fix internal links broken by the above (and any that were already broken).
5. **Archive.** Move `archive` and completed `merge-then-archive` files to the archive location. For file-based plans, archive the plan here too (see "Archive the plan").
6. **Delete.** Remove `delete` and completed `merge-then-delete` files.
7. **Verify.** Re-run consistency and link checks against the final state, then report (see "Verification report").

### Commit granularity

Scale the number of commits to the size of the review — never manufacture an empty commit just to match the list:

- **Small review** (a handful of files, no merges/restructure): a **single commit** is fine, e.g. `docs: align references with current codebase`.
- **Large review**: commit per *step that actually changed something*; skip steps with no changes. Keep the destructive steps (archive, delete) as their own commits so they're easy to review and revert.

Example messages for the steps that ran:

- `docs: merge preserved content from obsolete files`
- `docs: update references to match current codebase`
- `docs: restructure architecture docs`
- `docs: repair internal links`
- `docs: archive completed analyses`
- `docs: delete obsolete files`

**Changelog note:** if the repo derives its changelog from commits (git-cliff, release-please, conventional-changelog), many separate `docs:` commits all land in the "Documentation" section and bloat the next release entry. Detect this by checking for `cliff.toml` / `.git-cliff*`, a `release-please` config, or a `bump`/`release` script in `package.json`. When present, lean toward fewer commits and tell the user a squash may keep the changelog clean. Always respect a commit-message hook (commitlint/Husky): keep messages conventional and never `--no-verify`.

Use the user's preferred commit language if discernible from recent history (`git log --format=%s -20`); otherwise match the language of the existing docs.

### Archive location

Default: `docs/archive/YYYY-MM/` relative to the scope. Exception: if the repo already has an archive convention (e.g. `docs/_archive/`, `archive/`, per-category archive subfolders), follow it. Detect by checking for existing folders named `archive`, `_archive`, `archived`, `old` within `docs/` before creating a new one.

Preserve the original filename when archiving. If a collision would occur, prefix with date: `YYYY-MM-DD-original-name.md`.

### Archive the plan (file-based reviews only)

When a `docs-review-plan.md` was written, do **not** delete it. In the archive step, `git mv` it into the archive folder as the permanent, human-readable record of what changed and why: `docs/archive/YYYY-MM/docs-review-plan-YYYY-MM-DD.md`. This keeps the working tree clean (no loose untracked file lingering as future clutter) and preserves the rationale. The git commits remain the primary audit trail; the archived plan is its readable companion.

For small reviews done inline via plan mode there is no file — nothing to archive.

### Merge-before-delete rule

Never delete or archive a file whose content was flagged for preservation before the merge commit for that content exists and has been verified. If a merge fails (target doesn't exist, conflict, etc.), stop, report, and ask the user — do not fall through to deletion.

### Link repair

After structural changes, find all internal Markdown links (`[...](./path)`, `[...](path.md)`, `[...](path.md#anchor)`) and update those pointing to moved/renamed/removed files. For deleted targets without a clear successor, either:

- Remove the link and the sentence if it no longer makes sense, or
- Leave the link and flag it in the verification report for manual resolution.

Also check for links *from code* (comments, source files) into docs that were moved or removed. Do not silently rewrite code — report these in the verification step so the user can address them.

### Verification report

After all commits, produce a short report **as a chat message** — do **not** write a `docs-review-report.md` file. Cover:

- Files changed (counts per action type)
- Commits created (hashes + subjects)
- Broken-link cases that couldn't be auto-resolved
- Code-side references to moved/deleted docs (for the user to address)
- Any plan items skipped and why

For a large, file-based review you may instead append this report as a `## Results` section to the plan *before* archiving it, so the record and the outcome live together. Either way there is no temp file to clean up afterward.

---

## Safety guardrails

Non-negotiable:

- **Never operate on a dirty working tree.** Always check first.
- **Never force-push, rebase, or rewrite history.** Only additive commits.
- **Never operate outside the declared scope.** If analysis reveals out-of-scope issues, note them in the plan but don't touch.
- **Never delete without a preceding merge commit** for any to-preserve content.
- **Never skip the plan phase**, even for "small" reviews — but the plan may be inline (plan mode) rather than a file. The git commits, not any plan file, are the audit trail.
- **If anything is ambiguous at execution time, stop and ask.** The plan should have resolved ambiguity; if it didn't, that's a planning bug, not a reason to guess.

## Communication

- Match the user's language. If the conversation is in German, write the plan, commit messages, and verification report in German. If mixed, default to German with English commit-message verbs (`docs:` prefix is conventional).
- Keep progress updates short — one line per phase transition.
- Do not narrate every file read. Show counts and only surface specific files when they have findings.
- At the hand-off after Phase 2, lead with: plan file path, counts, anything flagged for review.

## When not to auto-proceed

Even after plan approval, pause and re-confirm if during execution you encounter:

- A merge target that doesn't exist as expected
- A file with uncommitted changes (someone edited it between plan and execute)
- Binary or unexpectedly large files in scope
- Symlinks pointing outside the scope
- `.md` files that are actually generated (detect via generator comments or adjacent `.template` / build scripts)

## Monorepo notes

In workspaces with multiple packages:

- Each package may have its own `README.md`, `CLAUDE.md`, and `docs/`. Treat each package's docs as a local cluster — its README references its own code, not siblings.
- Cross-package references in docs should be flagged if the target package was renamed or removed.
- A root-level `docs/` usually covers workspace-wide concerns (architecture, contributing). Don't move package-specific content there unless the plan says so explicitly.
- Root-level `CLAUDE.md` / `AGENTS.md` and package-level variants serve different audiences. Don't merge them.
