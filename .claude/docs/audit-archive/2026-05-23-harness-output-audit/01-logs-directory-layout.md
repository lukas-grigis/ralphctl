# 01 — Logs directory layout

**Status:** decided-change (2026-05-22)
**Owner:** unassigned
**Related:
** [03 truncation](03-truncation-policy.md), [06 execution.json](06-execution-json-slimming.md), [07 progress vs chain.log](07-progress-vs-chain-log.md)

## Problem

Logs are scattered across the sprint directory and embedded inside JSON aggregates.
A reader who wants to "see what the last setup run printed" or "tail what the
verify script said for task 3, attempt 2" has to dig through three different
file shapes (NDJSON, single-line text, JSON tail field).

## Current layout

| Artifact                   | Path                                                                                               | Shape                         | Writer                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| chain events               | `<sprintDir>/chain.log`                                                                            | NDJSON + boundary markers     | `src/integration/observability/sinks/file-log-sink.ts`              |
| decisions                  | `<sprintDir>/decisions.log`                                                                        | space-separated POSIX columns | `src/integration/observability/sinks/decisions-log-sink.ts`         |
| setup output               | inside `<sprintDir>/execution.json` → `setupRanAt[].stdoutTailBytes` (4096 B cap)                  | embedded string               | `src/application/flows/implement/leaves/setup-script-runner.ts:201` |
| verify output (pre + post) | inside `<sprintDir>/tasks.json` → `attempts[].{preVerify,postVerify}.stdoutTailBytes` (4096 B cap) | embedded string               | `src/application/flows/implement/leaves/{pre,post}-task-verify.ts`  |

## What's wrong

1. **Mental model conflict.** Logs and aggregates are interleaved. `execution.json` is supposed to be the audit
   _record_ (when, who, what outcome) — it currently doubles as a log _body_ (the actual stdout). Same for `tasks.json`.
2. **4 KiB tail cap is the wrong unit of fidelity.** A failing Maven build prints kilobytes per failing test — the
   tail-clip hides the head of the stack and the operator can't see the actual cause without re-running locally.
3. **`chain.log` is doing two jobs.** It is the machine-readable event stream AND the consumed-by-progress-md projection
   source (see [07](07-progress-vs-chain-log.md)). Anyone who tails it sees framework metadata mixed with mined signal
   text.
4. **No discoverability.** A new operator stares at `<sprintDir>/` and sees ten JSON files and two `.log` files with no
   top-level "where do I look for log output?" answer.

## Proposed direction

Introduce `<sprintDir>/logs/` as the canonical home for **script-only output** (setup + verify stdout/stderr).
Everything AI-related lives under per-spawn dirs (`implement/<task>/rounds/<N>/<role>/`, `readiness/<repo>/`, …). The
persistent `chain.log` and `decisions.log` are deleted entirely — `progress.md` is rebuilt as an append-only journal
per [07](07-progress-vs-chain-log.md), so the NDJSON-mining path no longer exists.

```
<sprintDir>/
  sprint.json              # planning aggregate
  execution.json           # branch + PR + SetupRun rows (metadata only, no tail bodies)
  tasks.json               # task array + VerifyRun rows (metadata only, no tail bodies)
  progress.md              # append-only journal — one section per task-attempt settlement
                           # AI session reads it as cumulative prior-sprint context (see [07])
  logs/
    setup/
      <repo-id>.log        # full stdout/stderr from setup-script (one per repo, untruncated)
    verify/
      <task-id>/
        pre-attempt-<N>.log
        post-attempt-<N>.log
  implement/
    <task-id>/
      rounds/<N>/
        generator/
          prompt.md           # harness-written AI input: rendered template (criteria inlined, see [05])
          sessionId           # harness-written: for --resume
          signals.json        # AI-written: Zod-validated AiSignal[] (see [09])
                              # contains: change/learning/note/decision + commit-message signal
          commit-message.txt  # harness-rendered from the commit-message signal (if present); piped to `git commit -F`
        evaluator/
          prompt.md           # harness-written AI input
          sessionId           # harness-written
          signals.json        # AI-written: Zod-validated AiSignal[]
                              # contains: lightweight signals + evaluation signal (verdict + dimensions + critique)
          evaluation.md       # harness-rendered from the evaluation signal (operator review)
  readiness/
    <repo-id>/
      prompt.md               # harness-written AI input
      sessionId               # harness-written
      signals.json            # AI-written: validated AiSignal[] (see [09])
      agents-md-proposal.md   # harness-rendered from the matching signal (if present); installed/diffed against repo's CLAUDE.md / AGENTS.md / etc.
      setup-skill.md          # harness-rendered from the matching signal (if present); installed verbatim into <repo>/<parentDir>/skills/setup/SKILL.md
      verify-skill.md         # harness-rendered from the matching signal (if present); installed verbatim into <repo>/<parentDir>/skills/verify/SKILL.md
  refinement/
    <ticket-id>/
      prompt.md  sessionId  signals.json    # signals contains refined-ticket signal
  plan/
    <run-id>/
      prompt.md  sessionId  signals.json    # signals contains task-plan signal
  ideate/
    <run-id>/
      prompt.md  sessionId  signals.json    # signals contains ideated-tickets signal
```

Each AI-spawning directory holds: **AI input** (`prompt.md`), **session metadata** (`sessionId`), and **AI output** (
`signals.json` + zero or more sidecar files). Sidecar files exist only when the bytes are installed/diffed/applied
elsewhere — see [09](09-ai-session-contract.md) for the rule.

Refine / plan / ideate / readiness follow the same shape under their own per-unit directories — each declares its own
file list via its `AiOutputContract`. See [09](09-ai-session-contract.md) for the per-leaf contracts.

**Files explicitly NOT in this layout** (deleted as part
of [05](05-done-criteria-separation.md) / [07](07-progress-vs-chain-log.md) / [09](09-ai-session-contract.md)
migration):

- `chain.log` — deleted as a default file. The in-memory event bus stays; the file sink is opt-in only via
  `RALPHCTL_DEBUG_TRACE=1`, which writes to `<sprintDir>/events.ndjson` (NOT under `logs/` — `logs/` is exclusively for
  script output).
- `decisions.log` — decisions originate as `decision` signals; they live in per-spawn `signals.json` and surface in
  `progress.md`'s per-attempt `#### Decisions` subsections via the [07](07-progress-vs-chain-log.md) journal model (no
  separate top-level `## Decisions` section — they're chronologically interleaved with task attempts). The intermediate
  `.log` file has no exclusive readers.
- `done-criteria.md` — criteria live in `Task.verificationCriteria` (source) and inside each rendered `prompt.md` (
  target). Standalone file is redundant. See [05](05-done-criteria-separation.md).
- AI-written sidecars (commit-message.txt, evaluation.md, agents-md-proposal.md, skill files) — the AI does **not**
  write any of these directly. The AI writes `signals.json` only; the harness extracts bodies from validated signals and
  renders the sidecars itself. See [09](09-ai-session-contract.md).

**Rules:**

- `logs/**/*.log` files are **untruncated** by default. The tail-cap pattern stays only for the small inline snippets
  that ride on bus events (TUI banner cause lines, error banner causes).
- `execution.json` and `tasks.json` keep `outcome`, `exitCode`, `durationMs`, `ranAt`, `command` — they do **not**
  reference the log file via a path field; the reader derives the path from the audit row's `repositoryId` (setup) or
  `taskId + attemptN + phase` (verify). See [06](06-execution-json-slimming.md) for the resolver-helper requirement.
- The TUI's existing 4 KiB-tail rendering becomes a lazy read of the last N bytes of the file rather than reading from
  JSON.

## Decisions (2026-05-22)

- **AI stdout persistence: NO.** The sandbox directory + persisted `sessionId` file already cover the resume-and-debug
  use case. No `generator.stdout.log` / `evaluator.stdout.log` files. Under [09](09-ai-session-contract.md), the
  validated `signals.json` is the canonical record of what the AI produced.
- **Slug format: reuse `Repository.id` and `Task.id` verbatim.** Both are already kebab-case, already unique within a
  sprint. No transform layer.
- **Backwards compatibility: via per-entity migrations** (revised 2026-05-22). The earlier "NONE" stance is replaced by
  the schema-versioning + migration pattern introduced in [09](09-ai-session-contract.md) and extended to repositories
  in [06](06-execution-json-slimming.md). Old sprints with `stdoutTailBytes` fields get migrated forward on load (the
  migration drops the legacy fields). Cost is negligible — one tiny migration step per affected entity — and in-flight
  sprints survive upgrades without operator action.
- **`chain.log` persistent file sink: DELETED** (was: rename + keep). In-memory event bus stays — TUI still subscribes
  for live rendering. Persistence is opt-in via `RALPHCTL_DEBUG_TRACE=1` for triage runs.
  See [07](07-progress-vs-chain-log.md).
- **`decisions.log`: DELETED.** Decisions are AI signals — they live in per-spawn `signals.json` (canonical) and
  `progress.md`'s per-attempt `#### Decisions` subsections (human view, appended by [07](07-progress-vs-chain-log.md)'s
  journal model). The standalone `.log` was an intermediate persistence step with
  no exclusive readers once [09](09-ai-session-contract.md) lands.
- **`logs/` is exclusively for script output** (setup + verify). One mental model: "this directory has things shell
  scripts wrote to stdout/stderr." Anything AI-related lives under `implement/<task>/rounds/<N>/`.

## Evidence

- `src/integration/observability/sinks/file-log-sink.ts` — chain.log writer
- `src/integration/observability/sinks/decisions-log-sink.ts:68,76` — 500-char decision body cap (`SINK_BODY_CAP`)
- `src/application/flows/implement/leaves/setup-script-runner.ts:192,201` — 4 KiB `SCRIPT_TAIL_BYTES` cap and where it's
  applied
- `src/domain/value/script-tail-bytes.ts:10` — the constant
- `src/business/sprint/write-progress-snapshot.ts` + `src/integration/persistence/load-chain-log.ts:23` — chain.log
  reader with 8 MiB tail cap

## Not yet decided

Do nothing until [03 truncation](03-truncation-policy.md) and
[06 execution.json](06-execution-json-slimming.md) land — they share data
shapes with this island.
