# Audit: clean up and retire

The procedure for a project whose docs, plans and trackers have grown. It harvests what
still holds into the canon and deletes the rest from a versioned store. It never moves
documents into an archive.

## When it is worth running

It needs a trigger; running it on a calendar only produces findings:

- `bun run docs:check` is red, or `AGENTS.md` is over its budget;
- a review, a consumer or a derailed session hit a claim that is false;
- a large batch of work or a large plan just ended;
- the layer is being introduced into an existing project ([setup.md](setup.md)).

## 0. Preflight

- The working tree is clean and you are on a branch (for tracked changes).
- **The working-docs folder is versioned before anything is deleted.**
  - In a private repo it is tracked already.
  - In a public repo the folder is git-ignored and its own repository: `git init` in it, and
    make the first commit the complete current state. Move any old archive folder in there
    first.
  - Deleting must be reversible, or it will not be done and the archive grows back.
- Check what reads the documents: grep outside the repo too (tool scripts, sandboxes) for
  hard-coded paths. A document that a tool reads is not retired; it is part of that tool.

## 1. Read everything, in parallel

Split the corpus by folder and give each reader the same brief. For each file, the reader
reports:

1. purpose in one sentence, and size;
2. lifecycle: LIVING (carries open work found nowhere else), DONE-WITH-REST or DONE;
3. the open rest, checked against the tracker (`gh issue view <N>`, or the Markdown tracker):
   is each item in the tracker, or does it live only here?
4. durable knowledge, one line per decision, rule, trap or measurement, each checked by grep:
   **already in the canon or memory** (`file:line`) or **ABSENT**. If ABSENT, does it still
   hold (check the code)?
5. drift: statements the code or tracker contradicts, marked VERIFIED or SUSPECTED;
6. re-read value if the document disappeared: NONE, PROVENANCE-ONLY or REFERENCE;
7. recommendation (keep, update, compress, harvest then retire, or retire) with confidence.

Also sweep **tracked code** for pointers into unpublished places:

- paths below the working-docs or private folders (`docs:check` finds these);
- review IDs and §-numbers of plans;
- "see <doc>" pointing at a document that no longer carries entries;
- hashes from before a history rewrite;
- numbers that lost their only source.

Expect the harvest to be small. In practice most "reason to keep" rows no longer hold: the
knowledge they protect is already in the canon, the tracker, the code or memory.

## 2. Plan

- **Small** (a handful of files): present the plan inline and wait for approval.
- **Large:** write it as a living doc in the working-docs folder. Its head: "Ends when the
  findings in § X are decided". Every destructive action names its target. Every harvest item
  names its source and its destination.

**Out-of-scope findings** — code defects the reading turned up — are listed in the plan, not
fixed in the docs PR. They change shipped behaviour and get their own PRs, or are dropped.

## 3. Execute, in this order

1. **Harvest into the canon: one PR** (or one branch of commits where the project has no PRs).
   Convert decisions, not documents. Verify each harvested claim against the code before writing
   it. Then run an **adversarial review in a fresh context**, one reviewer for prose and one for
   code comments. The same reviewer re-checks each fix against its finding (fix verification).
   Freshly harvested prose carries false claims as readily as code carries bugs.
2. **Sweep the code pointers** found in step 1 (same PR or a sibling). Keep each comment's
   constraint, drop the pointer, and name a canon heading or an issue number where one owns the
   rule.
3. **Compress the living docs.**
   - The status document loses every copied count and list.
   - Strategy and position papers merge into one.
   - Each living doc gains its end condition.
4. **Retire: `git rm`**, in the repository that holds the working-docs folder (in a public repo,
   `git -C docs/internal rm …`), one commit per group. The message names where each harvest
   went.
   - The working-docs `README.md` keeps at most five "in the history, should the question come
     back" lines, each with the path relative to that repository. They are only for documents
     that are the sole groundwork for a question that may return.
   - Nothing else gets an index row.
5. **Tracker actions** (outward-facing on a hosted tracker, so confirm first):
   - open issues only for problems someone noticed;
   - park a finding that stands but hurts no one;
   - rewrite an issue body as a checklist of what is still wrong;
   - propose closing issues that are done.
6. **Agent memory:**
   - fix stale paths;
   - delete memories whose rule is now codified;
   - check each project memory's delete condition.
7. **Verify:**
   - `bun run docs:check` is green, and so are the project's own lint and type gates;
   - greps for the pointer patterns come back empty;
   - links inside the working-docs folder still resolve;
   - read one retired file back as a test, in the repository that holds it:
     `git log --all --diff-filter=D -1 --format=%h -- '<path>'` gives the deleting commit `<c>`;
     `git show '<c>^:<path>'` prints the file; `git restore --source='<c>^' -- '<path>'` brings it
     back.

## Don't

- Don't archive. Don't write "reason to keep" rows. Don't compress a document you are about to
  retire: nobody will read the shorter version.
- Don't delete from an unversioned folder.
- Don't let the review run in the context that wrote the prose.
- Don't turn self-inspection findings into issues "so they survive the PR".

## Commits and changelog

If the changelog is generated from commits (git-cliff, release-please), commit per step on the
branch and squash-merge. The PR title then decides the single changelog entry, so give it the
right type. Harvest into docs is `docs:`, a code-comment sweep is `chore:`, a new gate rule is
`ci:`. Never add agent-session trailers where the project forbids them.

## Report

End with a short chat report:

- files changed per action;
- commits and PRs;
- issues opened, parked or rewritten;
- the out-of-scope findings still awaiting a decision;
- anything skipped, and why.
