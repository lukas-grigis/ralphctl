# Sprint lifecycle

A sprint moves through four states: `draft → active → review → done`. This page shows the
sequence of user actions that drive the transitions, not the full state machine.

## A typical sprint, end to end

```mermaid
sequenceDiagram
    actor User
    participant CLI as ralphctl
    participant Sprint as sprint.json + execution.json + tasks.json
    participant Tools as git · setup · verify · AI

    User->>CLI: create-sprint
    CLI->>Sprint: write sprint.json (status=draft)

    User->>CLI: add-tickets / refine / plan
    CLI->>Tools: AI session (refine + plan are read-only)
    CLI->>Sprint: tickets approved · tasks.json generated

    User->>CLI: implement
    CLI->>Sprint: auto-activate (status=active)
    CLI->>Tools: setup-script (once per repo)

    loop one task at a time (topological order)
        CLI->>Tools: pre-task verify · generator · evaluator · post-task verify
        CLI->>Sprint: append attempt · update task status
    end

    CLI->>Sprint: all tasks done → status=review

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

| Operation                  | draft | active | review | done |
| -------------------------- | :---: | :----: | :----: | :--: |
| Add / edit / remove ticket |   ✓   |   ✗    |   ✗    |  ✗   |
| Refine requirements        |   ✓   |   ✗    |   ✗    |  ✗   |
| Plan tasks                 |   ✓   |   ✗    |   ✗    |  ✗   |
| Implement                  |  ✓\*  |   ✓    |   ✗    |  ✗   |
| Review (apply feedback)    |   ✗   |   ✗    |   ✓    |  ✗   |
| Close (review → done)      |   ✗   |   ✗    |   ✓    |  ✗   |
| `sprint show / list`       |   ✓   |   ✓    |   ✓    |  ✓   |

\*`implement` auto-activates a draft sprint that has tasks.

## On-disk shape

```
<dataRoot>/sprints/<sprint-id>/
├── sprint.json          ← planning aggregate (tickets, status, project ref)
├── execution.json       ← runtime audit (branch, PR URL, per-repo setupRunAt)
├── tasks.json           ← task list with status + attempts
├── chain.log            ← EventBus trace (opt-in via RALPHCTL_DEBUG_TRACE)
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
- Mutators: `src/business/sprint/{create,plan,activate,transition-to-review,transition-to-done}.ts`
- Schema: `src/integration/persistence/sprint/sprint.schema.ts` (zod, with `schemaVersion`)
