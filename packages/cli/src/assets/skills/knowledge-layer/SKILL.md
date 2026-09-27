---
name: knowledge-layer
description: Where a project's knowledge lives and how it retires — AGENTS.md/CLAUDE.md, skills, docs, DECISIONS.md/ADRs, plans, roadmaps, TODO lists, trackers and agent memory. Use when writing, moving or deleting one of these; when recording a decision or asking where something belongs; when a plan or audit ends; when asked to clean up, consolidate or archive docs ("docs aufräumen", "archive old docs"); when setting the layer up; or when `docs:check` fails. Supersedes any skill that archives documents.
---

# The knowledge layer

Prose has no compiler: a wrong sentence is paid for by the next session. This skill puts each
kind of knowledge where it has an **oracle** (something that fails when it goes wrong) or an
**expiry** (a condition under which it is deleted). It supersedes any instruction to archive
finished documents.

## The one rule

**Every statement needs an oracle or an expiry.** What rots is a copy of something that lives
elsewhere:

- **numbers**: counts, sizes, totals;
- **states**: "open", "not yet verified";
- **pointers**: paths, section numbers, review IDs, hashes.

Write the query, not its result: the command behind a number, the tracker filter behind a list,
the heading a pointer names. A number without its command stays out.

## Where each kind of knowledge lives

| Kind | Home |
|---|---|
| What the code does | the code, its types, its tests — no prose |
| Why this line is the way it is | a comment at the line that states the constraint itself, never "see plan §3" |
| What consumers are promised | the shipped contract docs (READMEs, guides, API docs) |
| What was deliberately not done, and why | `docs/DECISIONS.md`, or the contract doc that owns the rule |
| What to do next | the project's one tracker |
| How to work in this repo | `AGENTS.md` (index) → skills (procedures) → `docs/` (depth) |
| How it came to be | git history and PR descriptions |
| Diagrams | generated from the source, or none |

Edge cases and worked examples: [placement.md](placement.md).

## Working documents

Plans, analyses, strategy and runbooks live in **one** folder, `<working-docs>`
(`docs/internal/` by default).

- **Tracked folder** (a private repo): it is ordinary docs. Links into it are fine.
- **Git-ignored folder** (a public repo): it must be a git repository of its own, or deleting
  a document is irreversible. No tracked file may name a path below it; for everyone else the
  pointer is dead. It exists only in the main checkout, and that is an accepted cost. `docs:check`
  derives which case applies from git and enforces it.

### Lifecycle

1. **Living.** A document carries what cannot be a tracker item (an open decision, a running
   experiment, a runbook). Within its first 20 lines it names its end, with one of these
   markers: `Ends when …`, `End condition: …`, or `Permanent` for runbooks and indexes. German
   documents may use `Endbedingung`, `Endet, wenn`, `Lebt, bis` or `Dauerhaft`. A subfolder
   with a `README.md` counts as one document.
2. **Harvest** when it ends:
   - a decision goes to `DECISIONS.md` or its contract doc;
   - a rule goes to the canon doc or skill that owns its family;
   - a trap goes to a skill;
   - an open remainder becomes a tracker item, but only if someone noticed the problem without
     looking for it; otherwise drop it explicitly;
   - a measurement survives only with its command.
3. **Retire** with `git rm`, in the repository that holds the folder. The commit message names
   where the harvest went. There is **no archive folder**. The only record of retired documents
   is a list of at most five lines in `<working-docs>/README.md`. It is reserved for documents
   that are the sole groundwork for a question that may return.

Reviews and audits end as a PR or commit, and their findings go in its description.

## Decisions

`docs/DECISIONS.md` is the ADR log for trade-offs that look like oversights. An entry is the
decision as heading, the reason in one paragraph, and **Revisit only if:** the condition under
which it expires; the format is in the file's head. No numbered ADR folder beside it. Convert
*decisions*, not documents: a finished plan holds zero to three, the rest is chronicle.

## The tracker

- **One per project, named in `AGENTS.md`.** Either issues (GitHub, Codeberg, …) or, where
  there is none, one tracked Markdown file of items, e.g. `<working-docs>/TRACKER.md`. That
  file opens with `Permanent`. Done items are deleted, git keeps them.
- **An item needs someone who noticed a problem without looking for it.** Findings of a review,
  audit or lint run belong to the change that found them: fix them there or drop them.
- **Parked** means closed with its finding intact.
- An optional status document holds only what the tracker cannot (clocks, open decisions,
  consumer state), and queries instead of counts or copied lists.

## The instruction layer

- **The index is `AGENTS.md`**, read by most agents. `CLAUDE.md` is a symlink to it or contains
  `@AGENTS.md`: Claude Code reads `CLAUDE.md`, and measurement shows it does not read
  `AGENTS.md` on its own. A project with only a `CLAUDE.md` uses that file as its index.
- **The index is short:** every session reads it in full. It has a word budget; procedures go
  into skills, reference depth into `docs/`.
- **One canon per rule family.** `docs/README.md` maps each topic to the one file that owns
  it. Everywhere else, the topic gets one sentence and a link.
- **Comments carry constraints, not history.** Provenance goes in the commit message.

## Agent memory

Memory holds only what is personal to the maintainer or has no home in the repo yet. **Codify
or delete:** once the repo holds it, delete the memory. Each project memory ends with its
delete condition; the memory index has a word budget ([placement.md](placement.md)).

## Gates

A gate is the last resort: first make the wrong state unrepresentable; a gate that remains asks
a real system and has a positive control. This layer's gate, `bun run docs:check`, checks
existence only — references resolve, nothing tracked points into an ignored working-docs
folder and that folder is its own repository, the index keeps its budget and reaches
`AGENTS.md`, working documents carry end markers, no archive folder, no open checkbox in a working
document other than the tracker. Whether a statement is *true* stays the review's job.

## Procedures

- Set the layer up in a project: [setup.md](setup.md).
- Clean up or review a project's docs: [audit.md](audit.md).
- The failures behind each rule, for when one is questioned: [evidence.md](evidence.md).
