---
name: reference-entity-symbol-names-drift
description: ARCHITECTURE § Data Models names entity mutators/fields that get renamed in code without a doc edit — grep every named symbol before trusting the section
metadata:
  type: reference
---

`.claude/docs/ARCHITECTURE.md § Data Models` is the section agents are pointed at for entity
shapes, and it accumulates symbol names that no longer exist. Every name in it is a claim —
`grep -rn "<symbol>" src` before repeating one.

Renames caught in the 2026-08-18 audit (all had ZERO hits in `src/`):

| Doc said                                               | Reality                                                                                                                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `affectedRepositories`                                 | never existed — repo targeting is `Task.repositoryId` vs `project.repositories`                                                                                                                 |
| `refineTicket` (Sprint mutator)                        | `replaceTicket` (`refineTicketUseCase` is the business use case, different thing)                                                                                                               |
| `activate` / `transitionToReview` / `transitionToDone` | `activateSprint` / `transitionSprintToReview` / `transitionSprintToDone`                                                                                                                        |
| `Ticket.requirementStatus`                             | `Ticket.status` (`pending → approved`), body in `requirements`                                                                                                                                  |
| `Attempt.recoveryContext`                              | `Attempt.recovering?: RecoveryContext`                                                                                                                                                          |
| `resolveProjectFile`                                   | `resolveProjectPath` (`integration/persistence/storage.ts`)                                                                                                                                     |
| `runDoctor()`                                          | `useSystemStatus().refreshDoctor()` (`runtime/system-status-context.tsx`)                                                                                                                       |
| `appendLearningsAndMirror`                             | `appendMemoryRecords` + `mirrorLearningsMd` — and the mirror is LAZY, rendered only at sprint close (`refreshMemoryMirrorLeaf`) and distill (`stampPromotedLeaf`), never on the hot append path |

Paired sections that repeat these names and must be edited together: `WORKFLOWS.md § Two-phase
planning` (ticket status + repo selection) and `PERFORMANCE.md § learning ledger`.
