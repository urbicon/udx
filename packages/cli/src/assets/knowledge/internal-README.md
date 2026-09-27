# Working documents

Plans, analyses, strategy and runbooks: what a consumer does not need.

> **Permanent.** This index lives as long as the folder.

Every document here names its end within its first 20 lines (`Ends when …`, or `Permanent`). When it ends, what still holds is
harvested into the tracked canon and the document is removed with `git rm`. There is no
archive: the history is the archive. Rules: skill `knowledge-layer`, § Lifecycle of a working
document.

| Document | Role | Ends when |
| --- | --- | --- |

## In the history, should the question come back

At most five lines: retired documents that are the only worked-out groundwork for a question
that may return, with the path relative to the repository that holds this folder. To read one
back, find the deleting commit with `git log --all --diff-filter=D -1 --format=%h -- '<path>'`,
then run `git show '<commit>^:<path>'`.
