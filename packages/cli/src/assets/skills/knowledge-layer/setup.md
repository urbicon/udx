# Setup: introduce the layer into a project

For a new project, or an existing one that never had it. If the project already has a grown
docs folder, finish this first, then run [audit.md](audit.md).

## 1. Decide the working-docs folder

One folder holds plans, analyses, strategy and runbooks. It is `docs/internal/` unless the
project sets `workingDocs` (step 6).

**Private repo:** the folder is tracked like the rest of the repo. Nothing to prepare.

**Public repo:** git ignores the folder, and it gets a repository of its own. Do this
*before* installing, so that nothing below it is ever staged in the outer repo:

```bash
mkdir -p docs/internal
grep -qx 'docs/internal/' .gitignore || echo 'docs/internal/' >> .gitignore
git rm -r -q --cached --ignore-unmatch docs/internal   # drop it from the outer index, keep the files
git check-ignore -q docs/internal || echo 'docs/internal is still not ignored' >&2
git -C docs/internal init -q
git -C docs/internal add -A && git -C docs/internal commit -q --allow-empty -m 'Initial state'
```

The folder then exists only in the main checkout: worktrees and CI never see it, and that is
the accepted cost. Nothing tracked may depend on it, and `udx` writes no template into it.
Give it a `README.md` yourself and commit it in the nested repository:

```markdown
# Working documents

Plans, analyses, strategy and runbooks: what a consumer does not need.

> **Permanent.** This index lives as long as the folder.

| Document | Role | Ends when |
| --- | --- | --- |

## In the history, should the question come back
```

Files that were tracked before this step stay in the outer repo's history, which is public.

## 2. Install

```bash
bunx @urbicon-ui/udx add knowledge
```

This writes:

- this skill, under `.claude/skills/knowledge-layer/`, as a `managed` file;
- `docs/DECISIONS.md` and `docs/README.md`, plus a `README.md` in the working-docs folder when
  that folder is tracked, each `create-only`, so files that already exist are left alone;
- the `docs:check` script (`udx docs check`);
- `@urbicon-ui/udx` as a devDependency.

`udx sync` keeps the skill current, and reports a locally edited copy as a conflict instead of
overwriting it (unless you pass `--force`). Improve the skill in udx, not in the project. A
project without `.udx.json` gets one; the next full `udx sync` there manages the rest of the
harness too.

## 3. Move the working documents in

Move plans, analyses and strategy notes into the folder, for example from an old `planning`
folder. Each one gets an end marker within its first 20 lines: `Ends when …`, or `Permanent`
for a runbook. A document with nothing left to do is harvested and retired right away
([audit.md](audit.md)).

## 4. Name the one tracker

Exactly one of:

- the repo's **issues**;
- where there is no issue tracker, **one tracked Markdown file** of items that opens with
  `Permanent`. In a private repo it goes in the working-docs folder (e.g. `TRACKER.md` there).
  A public repo keeps it outside the ignored folder.

Every other to-do list is triaged into it or dropped.

## 5. Fit AGENTS.md and CLAUDE.md

- `CLAUDE.md` is a symlink to `AGENTS.md`, or contains the line `@AGENTS.md`. A project with only
  a `CLAUDE.md` uses it as the index.
- Add this section to the index, in the file's language, and fill in the angle brackets:

  ```markdown
  ## Knowledge layer

  Where knowledge lives and how it retires: skill `knowledge-layer`. Open work lives only in
  <the tracker>. Working docs live in `docs/internal/` (<tracked | a local git repository of
  its own, never linked from tracked files>); each names when it ends. Trade-offs that look like
  oversights: `docs/DECISIONS.md`. Canon map: `docs/README.md`. Comments carry constraints, not
  history. `bun run docs:check` stays green.
  ```

- **Measure, cut, then budget.** Count the words with `wc -w AGENTS.md`. Cut:
  - provenance ("since the July rework we …");
  - procedures, which move to skills;
  - reference depth, which moves to `docs/`.

  Then set the budget to the result.

## 6. Configure

All keys are optional, in `package.json` → `"udx": { "docs": { … } }`. A malformed value,
an unknown key, an absolute path or one with `..` stops the check with exit 2 and names the key.

| Key | Default | Meaning |
|---|---|---|
| `index` | `AGENTS.md` (any case), else `CLAUDE.md` | the always-loaded instruction index |
| `budget` | unset: the count is only reported | word budget of the index |
| `workingDocs` | `docs/internal` | the working-docs folder |
| `tracker` | `"issues"` | or the path of the Markdown tracker file |
| `privateDirs` | only the working-docs folder, and only while git ignores it | more folders nothing tracked may point into: `"dir"` or `["dir", "reason"]` |
| `sources` | index, `CLAUDE.md`, `README.md`, `docs/**/*.md`, `.claude/skills/**/*.md`, package READMEs and docs | docs whose references are checked |
| `codeRoots` | every tracked file except the docs being checked | where identifiers written in upper snake case must exist; set it to narrow the search |
| `allowlist` | `[]` | `[text, reason]` pairs for genuine false positives (a file path exempts a working doc's checklist); a stale entry fails |

## 7. Wire the gate

1. Run `bun run docs:check` and fix what it finds. A genuine false positive gets an allowlist
   entry with its reason.
2. Make it part of what CI runs, for example a CI step after lint, or a `lint` script that runs
   both.
3. Fill the canon map in `docs/README.md`: each rule family the project has, with the one file
   and section that owns it. Where two docs state the same rule, pick one owner. The other keeps
   a sentence and a link.

## Done when

- `docs:check` is green and runs in CI;
- the index is within its budget and names the tracker;
- every working document carries an end marker;
- no archive folder remains.
