# Evidence: why each rule exists

Each rule answers a failure that was measured, not imagined. The figures come from one
repository (a Svelte UI library monorepo with agent-driven development), measured between
2026-07 and 2026-09. They are dated history, not claims about any project today. Read this
before relaxing a rule.

## An archive is a queue nobody drains → harvest, then delete

- **Failure:** six cleanup rounds moved finished documents into an archive, and none of them
  decided anything. The archive reached 81 files, and its index grew to 26 KB. Each row held a
  "reason to keep" that had to be maintained.
- **Measurement:** reading all 66 archived items found 43 with nothing left to harvest and 21
  with a sentence or two. Only 2 needed a decision. Several "reason to keep" rows were false
  when written: they named sections that did not exist and links that did not exist.

## An unversioned folder makes deletion impossible → the working-docs folder is versioned

- **Failure:** working docs lived in a git-ignored folder with no history and no backup, so
  deleting one was final.
- **Result:** documents were archived instead of deleted, and the archive grew, as above. The
  folder was also invisible in worktrees, so agents working there never saw it.

## Pointers rot where no gate looks → no tracked pointer into private folders

- **Failure:** a reference check excused every git-ignored path as "absent by design", which
  hid the dead pointers.
- **Measurement:**
  - 13 code comments pointed at internal documents that had been moved about seven weeks
    earlier.
  - The sweep that followed touched about 150 comments in all. They cited unpublished
    documents, review IDs defined only in an unpublished audit, §-numbers of retired plans
    and a hash lost in a history rewrite.
  - Several shipped in npm tarballs.

## Copied state is wrong within days → no counts or lists in status docs

- **Failure:** a status document copied milestone counts and issue lists.
- **Measurement:** four of its ten milestone counts were off, and eight issues it listed as
  open had already closed before its date line. The copy was wrong on the day it was written.
- **Why:** the tracker had moved on, and nothing tied the copy to it.

## A second list is a second tracker → one tracker per project

- **Failure:** a TODO file held 67 open entries next to 46 issues, and the usual query for
  "what is ready" never saw it.
- **Measurement:** on triage, 6 entries pointed at existing issues and 10 were filed as 11 new
  issues. The other 51 were dropped, 4 of them because they were already done.

## CLAUDE.md is what Claude Code loads → CLAUDE.md reaches AGENTS.md

A code-word probe on two Claude Code versions showed that `AGENTS.md` alone is not read, and
that it is read through `@AGENTS.md` in `CLAUDE.md`. A symlink was not probed; it is read as the
file it points to. Instructions that are never
delivered have no effect, however good they are.

## Memory has authority and no oracle → codify or delete

- **Failure:** a stale memory overrides a correct document.
- **Measurement:** before a cleanup, the memory folder held 222 files:
  - 87 were dead weight;
  - they held 15 contradictions;
  - 31 duplicated repo docs;
  - two contradicted the repo's own contract documents.

  New files arrived at about three a day.

## A decision outside its contract document gets lost → decisions go where the rule lives

- **Failure 1:** two contradictory maintainer decisions on the same question lived side by
  side for three weeks. One of them sat in a session transcript and one line of a doc, never in
  the issue.
- **Failure 2:** an implementing agent redefined a documented value to fit its fix. A second
  agent then rewrote the shipped contract to match, and the end-to-end suite turned red.

## Fresh-context review finds what the author verified → harvest is reviewed like code

- **Across five PRs** (from an audit's notes): reviews in a fresh context found the heaviest
  finding exactly where the implementer had "verified", in 4 of the 5.
- **In the cleanup that produced this skill:** fresh-context reviews found claims that were
  false against the code, both in the freshly harvested prose and in the rewritten code
  comments. Two of them were ones an agent would have acted on.

## Gates can be green for the wrong reason → every gate gets a positive control

- A check that reads zero files passes.
- So does a pattern that never matches.

Each rule of `docs:check` has a control that plants a violation and must fail. Each control
has been shown to fail when its rule is sabotaged. When `git ls-files` fails, the check exits 2
instead of passing on an empty corpus.
