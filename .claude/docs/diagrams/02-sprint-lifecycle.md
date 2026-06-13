# Sprint lifecycle

A sprint moves through five states: `draft → planned → active → review → done`, plus one recovery edge
`review → active` — unblocking a task on a `review` sprint reverts it to `active` so the unblocked task
can be picked up on the next Implement run. (`plan` flips `draft → planned`; `implement` activates
`planned → active`.)

## A typical sprint, end to end

```mermaid
sequenceDiagram
    actor User
    participant CLI as ralphctl
    participant Sprint as sprint.json + execution.json + tasks.json
    participant Tools as git · setup · verify · AI

    User->>CLI: create-sprint
    CLI->>Sprint: write sprint.json (status=draft)

    User->>CLI: add-tickets / refine
    CLI->>Tools: AI session (refine is read-only)
    CLI->>Sprint: tickets approved (status stays draft)

    User->>CLI: plan
    CLI->>Sprint: tasks.json generated · status=planned

    User->>CLI: implement
    CLI->>Sprint: activate (planned → active)
    CLI->>Tools: setup-script (once per repo)

    loop one task at a time (topological order)
        CLI->>Tools: pre-task verify · generator · evaluator · post-task verify
        CLI->>Sprint: append attempt · update task status
    end

    CLI->>Sprint: every task settled AND ≥1 done → status=review (all-blocked run stays active)

    opt Optional feedback loop
        User->>CLI: review
        loop until user submits empty round
            User->>CLI: feedback text
            CLI->>Tools: AI session applies edits · runs verify
            CLI->>Sprint: append feedback round
        end
    end

    User->>CLI: close (or sprint close <id>)
    CLI->>Sprint: status=done
```

## Operation matrix

| Operation                  | draft | planned | active | review | done |
| -------------------------- | :---: | :-----: | :----: | :----: | :--: |
| Add / edit / remove ticket |   ✓   |    ✗    |   ✗    |   ✗    |  ✗   |
| Refine requirements        |   ✓   |    ✗    |   ✗    |   ✗    |  ✗   |
| Plan tasks                 |   ✓   |    ✗    |   ✗    |   ✗    |  ✗   |
| Implement                  |   ✗   |   ✓\*   |   ✓    |   ✗    |  ✗   |
| Review (apply feedback)    |   ✗   |    ✗    |   ✗    |   ✓    |  ✗   |
| Close (review → done)      |   ✗   |    ✗    |   ✗    |   ✓    |  ✗   |
| `sprint show / list`       |   ✓   |    ✓    |   ✓    |   ✓    |  ✓   |
| `task unblock`†            |   ✗   |    ✗    |   ✗    |   ✓    |  ✗   |

\*`implement` activates a `planned` sprint (`planned → active`) on first launch; an already-`active`
sprint passes through idempotently. A draft sprint must be planned first.

†`task unblock` (TUI `u` / `ralphctl task unblock`) on a `review` sprint reverts the sprint to `active`
(`revertSprintToActive`) so the newly-`todo` task is picked up on the next Implement run. A non-`review`
sprint passes through the reopen untouched (idempotent). An all-blocked run stays `active` — no review
state to revert.

## On-disk shape

```
<dataRoot>/sprints/<sprint-id>/
├── sprint.json          ← planning aggregate (tickets, status, project ref)
├── execution.json       ← runtime audit (branch, PR URL, per-repo setupRanAt)
├── tasks.json           ← task list with status + attempts
├── events.ndjson            ← EventBus trace (opt-in via RALPHCTL_DEBUG_TRACE)
├── progress.md          ← human-readable journal (one section per settled attempt)
├── logs/setup/          ← full setup-script stdout/stderr per repo
├── logs/verify/         ← full verify-script stdout/stderr per task per attempt
└── <flow>/<unit>/       ← per-spawn AI sandbox (prompt.md + signals.json + sidecars)
```

The split keeps planning mutations isolated from execution-time writes — corrupting
`tasks.json` does not lose the sprint plan.

## Backed by

- Entity: `src/domain/entity/sprint.ts` + `sprint-execution.ts`
- Repositories: `src/domain/repository/sprint/{sprint,sprint-execution}-repository.ts`
- Mutators:
  `src/business/sprint/{create-sprint,plan-sprint,activate-sprint,transition-sprint-to-review,transition-sprint-to-done}.ts`
- Schema: `src/integration/persistence/sprint/sprint.schema.ts` (zod, with `schemaVersion`)
