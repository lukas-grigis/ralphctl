---
name: lesson-compare-then-write-guard-must-cover-every-write
description: A concurrency guard that compares one field before a chain of writes (plan/ideate assert-tickets-unchanged) leaves the other writes and the reject path open; probe it by running the tail leaves against a moved-on repo
metadata:
  type: feedback
---

When a diff adds a "refuse if another writer changed X" leaf in front of several writes, list every write that
follows it and ask what each one clobbers. `assertTicketsUnchangedLeaf` compares tickets only, then `save-tasks`
does a whole-file `taskRepo.saveAll` and `save-sprint` re-checks status last. Two holes survived: a sprint another
session already planned (tickets equal, status not `draft`) still gets its tasks overwritten before `planSprint`
refuses, and a REJECTED plan skips the assert (`planned === undefined`) yet `save-tasks` still rewrites tasks.json
with the list loaded at flow start. A docstring line like "a rejected plan writes nothing" is the tell.

**Why:** the gate and the unit tests exercise the guard against the one change they model (a ticket added mid
session). Nothing models "sprint left draft" or the reject path, so the green suite says nothing about them.

**How to apply:** compose the real tail leaves in a `sequential` inside a scratchpad `.ts`, back them with in-memory
repos that already hold the "other session" state, and run it with `cd <repo> && npx tsx <scratchpad>/probe.ts`
(tsx resolves the repo's `@src/` and `@tests/` aliases from the cwd tsconfig, so `tests/fixtures/*` import fine).
Print the trace and the repo contents afterwards. Also grep who else writes the same files with a blind `save()`
(`transition-to-done`, `activate-sprint`, field editors): `sprintRepo.update` and the sprint-dir lock do not exclude them.
