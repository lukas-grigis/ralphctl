# Task lifecycle

A task moves through four states. The implement flow runs the per-task subchain that drives
the transitions. Each task carries an `attempts[]` history — one entry per
generator-evaluator round inside a single chain run.

## Task states

```mermaid
stateDiagram-v2
  [*] --> todo: plan flow generates task

  todo --> in_progress: implement —\nstart-attempt-leaf

  in_progress --> done: evaluator passes\n+ post-task check passes
  in_progress --> blocked: evaluator fails\n+ maxAttempts exhausted\n— or — branch-preflight fails\n— or — check-script fails
  in_progress --> todo: resume after crash\n(reset-stale-in-progress)

  blocked --> todo: manual unblock\n(future)

  done --> [*]
  blocked --> [*]: counted complete\nby implement→review

  note right of in_progress
    Inside this state, the
    gen-eval loop runs (see below).
    On crash, the next implement run
    resets in_progress → todo so the
    task re-enters the queue.
  end note

  note left of blocked
    Counted as terminal for the
    purpose of implement→review.
    No automatic retry —
    surfaces in sprint progress.
  end note
```

## Per-task gen-eval loop (inside `in_progress`)

```mermaid
flowchart TB
  start([startAttemptLeaf<br/>append a new Attempt to task.attempts]) --> build[buildTaskWorkspaceLeaf<br/>materialise sandbox folder]
  build --> loop_in

  subgraph loopBody["loop 'gen-eval'<br/>shouldStop: attempt.evaluation.passed === true<br/>maxIterations: task.maxAttempts ?? settings.harness.maxAttempts"]
    direction TB
    loop_in[/iteration N/] --> gen[generatorLeaf<br/>headless AI session<br/>writes signals.json + sessionId]
    gen --> ev[evaluatorLeaf<br/>headless AI session<br/>passes ? / critique]
    ev --> fin[finalizeGenEvalLeaf<br/>persist attempt to tasks.json<br/>update lastVerdict / lastCritique]
    fin --> check{passed?}
    check -->|yes| exit_pass([exit loop — settlement decides done])
    check -->|no, budget left| loop_in
    check -->|no, budget exhausted| exit_fail([exit loop — settlement decides blocked])
  end

  exit_pass --> postCheck[postTaskCheckLeaf<br/>run repo's checkScript]
  exit_fail --> settle
  postCheck --> checkRes{exit code}
  checkRes -->|0| commit[commitTaskLeaf<br/>git commit on sprint branch]
  checkRes -->|non-zero| settle
  commit --> settle[settleAttemptLeaf]

  settle --> outcome{outcome}
  outcome -->|evaluator passed<br/>+ check passed| markDone[markTaskDone]
  outcome -->|evaluator failed<br/>maxAttempts hit| markBlocked[markTaskBlocked]
  outcome -->|check-script failed| markBlocked2[markTaskBlocked]

  markDone --> taskDone(((done)))
  markBlocked --> taskBlocked(((blocked)))
  markBlocked2 --> taskBlocked

  classDef leaf fill:#e7f0ff,stroke:#1d4ed8
  classDef decision fill:#fff3e0,stroke:#d97706
  classDef terminal fill:#e8f4f0,stroke:#2d6a4f
  class start,build,gen,ev,fin,postCheck,commit,settle,markDone,markBlocked,markBlocked2 leaf
  class check,checkRes,outcome decision
  class taskDone,taskBlocked terminal
```

## Iteration budgets

| Setting                             | Range    | What it bounds                                    |
| ----------------------------------- | -------- | ------------------------------------------------- |
| `settings.harness.maxTurns`         | 1–10     | Generator-evaluator turns budgeted per attempt    |
| `settings.harness.maxAttempts`      | 1–10     | Default cap on attempts per task before `blocked` |
| `settings.harness.rateLimitRetries` | 0–10     | Adapter-side 429 retries with exponential backoff |
| `task.maxAttempts` (per-task)       | optional | Overrides the global cap for one task             |

All three are mirrored on `IterationConfig`
(`src/application/chain/run/iteration-config.ts`).

## Resume-after-crash semantics

Tasks left in `in_progress` from a prior crash are reset to `todo` on the next implement
launch (via the `reset-stale-in-progress` leaf at the top of the implement chain) and
re-enter the queue. No double-execution; the in-progress attempt is dropped from the
`attempts[]` history.

## Backed by

- Entity: `src/domain/entity/task.ts` (with `attempts[]`, `verification`, `evaluation`)
- Repository: `src/domain/repository/task/`
- Mutators: `src/business/task/{create-tasks,update-task,mark-blocked,record-evaluation,
reset-stale-in-progress}.ts`
- Per-task leaves: `src/application/flows/implement/leaves/`
- Schema: `src/integration/persistence/task/{task,attempt,evaluation,verification}.schema.ts`
