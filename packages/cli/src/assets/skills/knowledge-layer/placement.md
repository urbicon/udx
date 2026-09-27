# Placement: worked examples and edge cases

The table in `SKILL.md` answers most cases. This file is for the ones it does not settle.

## Ask in this order

1. **Is it true of the code right now, and visible in it?** Then it needs no prose. At most a
   test pins it. Prose that re-describes code is a second implementation that nothing checks.
2. **Is it a promise to someone outside the repo** (an API, a behaviour, a limit)? It goes in
   the shipped contract doc. That doc decides which side is wrong when code and doc disagree.
3. **Is it an option that was rejected, or a trade-off that looks like a mistake?** It goes in
   `DECISIONS.md`, or in the contract doc if one contract owns it. Always add *Revisit only
   if*.
4. **Is it work?** It goes in the tracker, if someone noticed it without looking for it.
   Otherwise fix it in the PR that found it, or drop it.
5. **Is it a procedure an agent follows** (a checklist, an order of steps, a trap tied to a
   step)? It goes in a skill.
6. **Does every session need it?** Then it goes in `AGENTS.md`, and it costs budget. Most
   things that feel this important are procedures (5) or pointers (one line plus a link).
7. **Is it a trap with no procedure to attach to?** It goes in a tracked doc that owns the
   area, e.g. a canon doc's pitfalls section. Agent memory holds it only when it is personal to
   the maintainer, because memory is local to one machine and the rest of a team never sees it.
8. **Is it history?** It goes in the commit message or the PR description.

## Comments

| Instead of | Write |
|---|---|
| `// see plan §3.4` | the rule §3.4 established, in one sentence |
| `// (R-12) row rhythm` | `// rows share one rhythm — docs/<canon-doc>.md § <heading>` |
| `// fixed in the #412 review` | nothing (that is the commit message); keep `#412` only if the issue is still the place to read more |
| `// ~18 % of files flag` | the number with the command that reproduces it, or no number |
| `// mirrors the table in foo.ts` | derive one from the other; if that is impossible, the comment plus a test that fails on drift |

A bare issue number is a fine pointer: it resolves for everyone and says where to read more.
A pointer to a document is fine only when the document is tracked and has that heading.

## Numbers, states and pointers in docs

- **A count that only introduces a list in the same paragraph** ("three rules:") is its own
  oracle and may stay. A count of something in the tree ("the 47 components") needs its
  command or goes. A retyped roster counts as a number.
- **Status markers** like "Decided 2026-09-14, pending #N" are allowed while #N is open. When
  it closes, write the decision into the prose or delete the marker.
- **Tracker state never goes into a doc.** Link the query instead:
  `gh issue list --milestone "<title>"`.

## Decisions: DECISIONS.md or the contract doc?

- The decision shapes one shipped contract (a feature the package will not offer, an API
  rule): put it in that contract doc, because consumers read it there.
- It crosses contracts or concerns the repo itself (the linter choice, something the project
  will not build, why a gate runs at release): put it in `DECISIONS.md`.
- It is an internal strategy decision (audience, positioning): put it in the one strategy doc
  in the working-docs folder, not in public docs.
- Write it once. Every other place keeps a sentence and a link.

## Plans, reviews, feedback, evaluations

- **A plan** is a living document while the work runs. It names its end ("Ends when #N–#M are
  merged"). It is not a tracker: items it spawns go to the tracker, and the plan links them
  without copying their state.
- **A review or audit** reports its findings in the PR, or the commit, that acts on them. If
  its findings outlive one change, the plan that carries them is a living doc: "Ends when the
  findings in §6 are decided."
- **Consumer feedback** is triaged into tracker items, plus decisions into contract docs. The
  raw feedback document retires when triage is done; the issue bodies carry the substance.
- **Evaluations and measurements.** The finding goes where it is used (a contract doc, a
  decision, a README), with its command or with how strong the evidence is ("one run"). Raw
  runs are provenance and retire. A harness that a future run needs stays as a living doc
  ("Ends when: 2026-12-31, unless a new run is decided") together with its runner. It is one
  subfolder with a README.

## Public canon, private working docs

- When knowledge must exist in public and in private, **the public file is the canon** and the
  private one links to it, never the reverse.
- No tracked file names a path below the working-docs folder: not a doc, not a code comment,
  not a test title. Naming the bare folder is fine ("working docs live in `docs/internal/`").
- Language follows the project's rule. A common one: reference docs in English, internal
  working docs in the team's language.

## Agent instructions

- `AGENTS.md` holds rules and pointers. A sentence that is provenance ("since the 2026-07 wave
  we…") names no constraint the next edit would honour; cut it.
- A skill holds a procedure plus the traps that belong to its steps. It loads when its
  description matches, so the description names the situations, not the topic.
- Canon docs hold reference depth. A doc that owns a rule family says so. `docs/README.md` maps
  each family to its owner.

## Agent memory

- Write a memory only for what has no home in the repo yet. When the repo gains that home,
  delete the memory.
- A project memory is a status that will end, so it carries its delete condition.
- A feedback memory holds the maintainer's stated preference: quote it, and give the why.

## Instruction layer, in more detail

- **Why `CLAUDE.md` must reach `AGENTS.md`:** a probe with a code word showed that Claude Code
  does not read `AGENTS.md` on its own, but does read it through `@AGENTS.md` in `CLAUDE.md`. A
  symlink named `CLAUDE.md` is read as the file it points to.
- **Budget the index in words.** Set the budget after cutting, not before. A budget that
  freezes today's size buys nothing.
- **Say what the canon map means.** A doc that owns a rule family can say so at the section
  (`> **Canon.**`). `docs/README.md` lists every family with its owner, and both directions must
  hold: every owner is listed, and every listed owner exists.

## Design decisions in projects using urbicon

A project on the urbicon design loop records *design* decisions (why this layout, this
component) in its design manifest via `urbicon record-decision`. Engineering trade-offs still go
to `DECISIONS.md`.

## Agent memory, in more detail

- **The memory index is loaded every session.** Give it a budget (for example about 1,250
  words), measure it with `wc -w` on the index file, and trim it before adding.
- **Hooks name the trap in plain words**, not a chronicle of when it was found.
- **When unsure, move a memory aside instead of deleting it**, into a dated folder next to the
  memory folder. That keeps the move reversible and costs no index lines.
