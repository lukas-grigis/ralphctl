# Harness Output & Performance Audit

A living backlog of investigations into how the harness emits artifacts to disk,
how those artifacts are consumed downstream, and where truncation/structure
hurts performance or fidelity.

Each "island" below is a self-contained note: status, evidence (with file:line
citations), open questions, and a proposed direction. Update an island in place
as new evidence lands — do not re-write history; append.

## Index

| #   | Island                                                                                       | Status            | One-line                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | [Logs directory layout](01-logs-directory-layout.md)                                         | decided-change    | `<sprintDir>/logs/` exclusively for script output (setup + verify). chain.log + decisions.log deleted; events trace is opt-in.                                                                          |
| 02  | [Signal contract: namespaces and uniform AI output](02-signal-contract.md)                   | decided-change    | Two namespaces (AiSignal Zod-validated, FrameworkEvent internal). AI writes exactly one file per spawn (`signals.json`); harness renders sidecars from validated signals.                               |
| 03  | [Truncation policy](03-truncation-policy.md)                                                 | decided-change    | Single rule: truncate at display, never at persistence. Setup/verify forward 1:1 to logs/; AI artifacts uncapped via [09].                                                                              |
| 04  | [Setup-script lifecycle](04-setup-script-failure.md)                                         | decided-change    | New sprint = tree-clean + run setup (hard gates). Resume = warning + skip setup. Gate uses existing `setupRanAt` audit.                                                                                 |
| 05  | [Done-criteria — delete the standalone file](05-done-criteria-separation.md)                 | decided-change    | Delete `done-criteria.md`. Source = `Task.verificationCriteria`; target = rendered `prompt.md` (criteria inlined). TUI renders from memory.                                                             |
| 06  | [execution.json + tasks.json slimming](06-execution-json-slimming.md)                        | decided-change    | Delete `stdoutTailBytes`/`stderrTailBytes`. Full output to `<sprintDir>/logs/`. Per-entity schemaVersion + migration map; in-flight sprints upgrade transparently (mirrors [09]'s contract migrations). |
| 07  | [progress.md is append-only; chain.log + decisions.log deleted](07-progress-vs-chain-log.md) | decided-change    | Journal model: one section appended per task-attempt settlement. AI session reads progress.md as prior-sprint context.                                                                                  |
| 08  | [Prompt template ↔ done-criteria coupling](08-prompt-done-criteria-coupling.md)              | decided-keep      | Two-place floor after [05](05-done-criteria-separation.md): source = `Task.verificationCriteria`, target = rendered `prompt.md` (both templates).                                                       |
| 09  | [AI session contract](09-ai-session-contract.md)                                             | open (foundation) | AI writes exactly one file (`signals.json`, Zod-validated). Harness renders operator-readable sidecars from validated signals. Per-leaf `schemaVersion` + migration chain handles in-flight upgrades.   |
| 10  | [Leaf tests with mock AI](10-leaf-tests-mock-ai.md)                                          | open              | Nine-branch test grid per AI-spawning leaf. Mock provider writes a single `signals.json` fixture per case.                                                                                              |
| 11  | [Prompt template unit tests](11-prompt-template-unit-tests.md)                               | open              | Placeholder ↔ parameter parity; partial existence; rendered contract example round-trips through the leaf's `signalsSchema`. Enforced via ESLint rule, not scaffolds.                                   |

## Glossary

- `<sprintDir>` — `<dataRoot>/sprints/<sprint-id>/`
- `<unit-slug>` — task id (implement) or run slug (refine / plan)
- "Round" — one generator → evaluator pair inside the per-task loop
- "Attempt" — outer loop unit, ends when evaluator passes or `maxAttempts` fires

## Working conventions

- File:line citations are mandatory for every claim — they prevent reasoning from drifting after refactors.
- Mark islands `decided-keep` / `decided-change` / `superseded → NN` / `done` when consensus is reached. Do not delete —
  historical context for the next person.
- New evidence that contradicts a decided island reopens it; add an "Update YYYY-MM-DD" block.
- Cross-link islands liberally with relative links — many concerns are entangled (truncation ↔ logs dir, signals ↔
  progress.md, …).

## Suggested implementation order

The islands have dependencies. A sensible sequencing for an implementation session:

1. **[04](04-setup-script-failure.md)** — implement the new-sprint-vs-resume gate. Tiny diff, unblocks nothing but cheap
   to land first.
2. **[09](09-ai-session-contract.md) foundation** —
   `src/integration/ai/contract/{signals/, types.ts, validate-signals-file.ts, render-sidecars.ts, render-contract-section.ts, render-evaluation-markdown.ts}`.
   Pure new code; touches no flow yet.
3. **[11](11-prompt-template-unit-tests.md)** — land the placeholder-parity and contract-example-roundtrip tests before
   changing prompts. ESLint rule + test helpers.
4. **[10](10-leaf-tests-mock-ai.md)** — mock provider helper + fixture conventions. ESLint rule for missing test grids.
   Touches no leaf yet.
5. **[09](09-ai-session-contract.md) per leaf** — generator first, then evaluator, then refine/plan/ideate/readiness.
   Each leaf ships its `<leaf>.contract.ts`, prompt update, and test grid in one PR.
6. **[07](07-progress-vs-chain-log.md)** — journal model: delete `write-progress-snapshot.ts` / `state-projection.ts` /
   `load-chain-log.ts` / `load-decisions-log.ts` / `decisions-log-sink.ts`; collapse `outcome.md` writer into the
   journal-append step; make `file-log-sink.ts` opt-in. Only possible once [09](09-ai-session-contract.md) is on every
   flow.
7. **[01](01-logs-directory-layout.md) + [06](06-execution-json-slimming.md)** — paired.
   `<sprintDir>/logs/{setup,verify}/` lands; setup/verify leaves write full output there; `stdoutTailBytes` /
   `stderrTailBytes` fields stripped from domain types.
8. **[03](03-truncation-policy.md)** — sweep: delete `SCRIPT_TAIL_BYTES`, audit display clips, ship the "truncate at
   display only" invariant as a fence.
9. **[05](05-done-criteria-separation.md) + [08](08-prompt-done-criteria-coupling.md)** — delete `done-criteria.md`
   writer + port; update TUI to render from `Task.verificationCriteria`. Documentation-only updates to CLAUDE.md.
