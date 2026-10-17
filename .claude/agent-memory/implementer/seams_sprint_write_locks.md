---
name: seams_sprint_write_locks
description: The two sprint locks that do not exclude each other, why long-held flows must end in update(), the plan/ideate commit predicate, and the stub trap it creates
metadata:
  type: project
---

## Two sprint locks, different keys

`withRepoLock` (implement / review / close / unblock) keys on the sprint DIR hash; `sprintRepo.update`
takes `sprint-<id>.lock`. Ticket writers (add / remove / publish / link), refine and the plan/ideate
commit only take the second. **Why it matters:** holding the sprint-dir lock does NOT stop a ticket
write, so any flow that holds a loaded sprint across a prompt or AI step must make its final sprint
write through `update(fresh => …)`, never a blind `save(ctx.sprint)` — the done transition was
converted for exactly this. Still blind (known follow-up, not a bug to "discover"): to-review,
activate, reopen and the unblock status flips.

## Plan/ideate commit tail

- The ONLY commit predicate is "ctx sprint is `planned`" (reject leaves it `draft`). All three tail
  leaves read it; `save-tasks` there is the commit-gated leaf in `commit-planned.ts`, not the generic
  `saveTasksLeaf`. Swapping it back makes a rejected plan rewrite `tasks.json` with the flow-start copy
  and wipe a concurrent session's plan.
- The assert refuses a fresh sprint that is no longer `draft` before the task write; save-sprint's
  `planSprint` under the lock is only the backstop (it runs after the task write).
- The task write is still outside the lock: `UpdateSprint.update`'s mutate is synchronous. Closing that
  needs a port change. Reordering to sprint-first is NOT the fix — tasks-first is load-bearing
  (`planned` means "tasks are ready", and nothing re-plans a non-draft sprint).

## Stub trap

Close / review / plan / ideate test stubs need `withUpdate` from the sprint-repo-update fixture. A bare
`{ findById, save } as SprintRepository` cast typechecks and then throws a TypeError at the
`update` call, which the runner reports as a generic failure, not a missing-method hint.

Related: [[seams_memory_ledger_and_mutex]], [[seams_process_lifecycle]].
