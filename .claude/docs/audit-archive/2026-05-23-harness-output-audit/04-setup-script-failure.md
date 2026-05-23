# 04 — Setup-script lifecycle: new-sprint vs resume

**Status:** decided-change (2026-05-22)
**Related:** [01 logs dir](01-logs-directory-layout.md), [06 execution.json](06-execution-json-slimming.md)

## Policy

| Lifecycle event                                                     | Working tree                                                    | Setup script                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **New sprint** — first implement invocation on this sprint          | **Must be clean** (hard gate; abort on dirty)                   | **Runs if present** (hard gate; abort on non-zero exit or spawn-error) |
| **Resume** — any subsequent implement invocation on the same sprint | Warning only (mirrors the existing tree-clean-on-resume policy) | **Skipped entirely** — does not run again                              |

Setup is treated as a _sprint-start ritual_, not a _per-run check_. Once the
tree has been validated against the setup script on this sprint, the harness
trusts subsequent invocations.

## Why this is right

1. **Setup is idempotent but slow.** `pnpm install`, `mvn dependency:go-offline`, `bundle install` — all idempotent, but
   they take 10-60 seconds. Running them on every resume burns time for no gain.
2. **The first run is the meaningful gate.** Setup proves "this tree builds before the AI touches it." Once proven, the
   sprint is committed to that state.
3. **Resume happens often.** Aborted runs, Ctrl-C, machine reboots — each restart should be near-instant, not "wait 30s
   while pnpm installs nothing new."
4. **Symmetric with tree-clean.** Tree-clean is now a warning on resume because the AI has been committing into the
   tree; the same logic applies to setup. The strict gate at sprint start is enough.

## Detection mechanism

The harness already persists per-repo setup attempts in `SprintExecution.setupRanAt[]` (
`src/domain/entity/sprint-execution.ts`). The gate becomes:

```
For each affected repo in the sprint:
  - if SprintExecution.setupRanAt contains an entry for this repo with outcome === 'success':
      → SKIP this repo's setup (resume path)
  - otherwise:
      → RUN this repo's setup (new path)
```

This handles the partial-failure case naturally:

- Repo A setup succeeded, Repo B setup failed, chain aborted → `setupRanAt = [A:success, B:failed]`.
- Operator fixes Repo B's environment, re-runs implement.
- Repo A is skipped (already-success entry); Repo B runs again (no success entry).
- This is the correct behaviour — Repo A doesn't need re-installing; Repo B does.

Implication: the per-repo loop in `setup-script-runner.ts` reads
`setupRanAt` before deciding to run each repo. No sprint-level boolean flag
needed; the existing audit array already carries the state.

## Today's behaviour (pre-migration)

Code analysis (`src/application/flows/implement/leaves/setup-script-runner.ts:90–305`):

- The leaf is composed unconditionally in `flow.ts:456` — runs on **every** implement invocation.
- The per-repo loop has no gate against re-running. Every implement invocation runs setup for every repo.
- Outcomes: `skipped` (no script), `success`, `failed` (non-zero exit), `spawn-error` (shell could not start).
- `success` / `skipped` → loop continues to next repo.
- `failed` / `spawn-error` → `Result.error(InvalidStateError)` → chain aborts.

So:

- **Failure abort is correct** (the user's earlier concern; the audit confirmed code returns `Result.error`).
- **Always-runs-on-resume is wrong** under the new policy.

## Reconciling the earlier "continue on failure" report

The user's earlier observation was almost certainly the `skipped` outcome (no
script configured → warn + continue). The code does abort on actual failures.
We can park the repro item unless a real failure-then-continue case emerges
after the new policy lands.

## What the leaf becomes

Replace the unconditional loop in `setupScriptRunnerLeaf` with a
`setupRanAt`-gated loop. Pseudo-code:

```ts
for (const repo of opts.repos) {
  const priorSuccess = execution.setupRanAt.some(
    (r) => r.repositoryId === repo.repositoryId && r.outcome === 'success'
  );
  if (priorSuccess) {
    // resume path — log + continue
    deps.eventBus.publish({
      type: 'log',
      level: 'info',
      message: `setup-script ${String(repo.path)}: skipped on resume (succeeded earlier on this sprint)`,
      at: deps.clock(),
    });
    continue;
  }
  // new path: run the script (existing logic stays)
  // ... spawn, capture, persist SetupRun, abort on failure ...
}
```

No new domain types. No sprint-level state. The audit log is the gate.

## Edge cases worth thinking through

- **Sprint was created on harness vX, resumed on harness vX+1 with a new gate** — `setupRanAt` shape is unchanged (no
  schema bump needed). Resume detection works across versions.
- **Operator manually edits `project.json` to change the setup command** — the gate sees the old success entry and
  skips. **This is wrong** for the operator's intent. Mitigation: store the command text alongside the audit row (
  already done — `SetupRun.command`), and re-run if the command has changed. Add to action items.
- **Operator wants to force-re-run setup** — give them an explicit CLI flag: `ralphctl sprint <id> --re-run-setup` that
  clears the success entries and re-runs the leaf. Out of scope for the initial policy change; capture as follow-up.
- **Empty setupScript on resume** — already `skipped` outcome today; stays `skipped` on resume. No change needed.

## Action items

- [ ] Update `setupScriptRunnerLeaf` to read `execution.setupRanAt` and skip per-repo when a prior success exists.
- [ ] Add a log + event for the "skipped on resume" branch (separate from "skipped because no script configured" —
      different reasons, different banner tier).
- [ ] Detect command drift: if `SetupRun.command !== current repo.setupScript`, run again (treat as new). Audit row
      records both old and new command for diff.
- [ ] Add unit test: given `setupRanAt = [A:success]` and `repos = [A, B]`, the leaf runs only B.
- [ ] Add unit test: given `setupRanAt = [A:failed]` and `repos = [A]`, the leaf runs A again.
- [ ] Add an integration test for the full new-vs-resume distinction (driving an implement chain twice on the same
      sprint, asserting setup runs once).
- [ ] Document the policy in `.claude/docs/ARCHITECTURE.md` under the implement-flow section, next to the tree-clean
      policy.
- [ ] (Stretch) `ralphctl sprint <id> --re-run-setup` operator override.

## Evidence

- `src/application/flows/implement/leaves/setup-script-runner.ts:90–305` — current leaf body
- `src/application/flows/implement/flow.ts:456` — unconditional composition site
- `src/domain/entity/sprint-execution.ts` — `setupRanAt[]` shape
- The symmetric "tree-clean → warning on resume" policy already in the implement chain — same shape, this island extends
  it to setup.
