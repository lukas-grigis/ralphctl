# 07 — `progress.md` is an append-only journal; `chain.log` and `decisions.log` are deleted

**Status:** decided-change (2026-05-22)
**Related:
** [01 logs dir](01-logs-directory-layout.md), [02 signal contract](02-signal-contract.md), [09 AI session contract](09-ai-session-contract.md)

## Decision in one paragraph

`progress.md` becomes a **pure append-only journal**. A sprint header lands at
the top once, written at sprint creation. After every task-attempt settlement,
the harness appends one section recording what happened. Status transitions
(active → review → done) append a separator line. No rewrites, no projection,
no mining of other files. Operators see the chronological build-up; the AI
session reads it as cumulative prior-sprint context.

`chain.log` and `decisions.log` are **deleted** (both files, both writers,
both readers). The in-memory event bus stays.

## Why journal, not snapshot

The snapshot model (`writeProgressSnapshot` + `state-projection.ts`) had three quiet problems:

1. **Mining is fragile.** Re-deriving "what happened" from chain.log + decisions.log + entities means a refactor of any
   of the three sources can silently break the projection. The append-only model writes once, at the moment the event
   happens, from the data already in hand — no second source to drift against.
2. **History gets flattened.** A snapshot shows you the current state; a journal shows you the path. For a 12-task
   sprint, "task 3 got re-run after task 7 surfaced a constraint" is a story the operator wants to read, not a derived
   state to re-render.
3. **The AI's context wants a narrative.** When task 8 starts, the model wants to know _what happened in tasks 1-7_ —
   decisions made, learnings recorded — to avoid re-litigating them. A chronological journal is the right shape for that
   input.

## What gets appended, when

| Event                   | Section appended                                                    | Trigger                               |
| ----------------------- | ------------------------------------------------------------------- | ------------------------------------- |
| Sprint creation         | Sprint header (name, id, created-at) — **no ticket list**           | `create-sprint` flow, once per sprint |
| Sprint activation       | `--- *Sprint activated at <iso>* ---`                               | `activate-sprint-leaf`                |
| Task-attempt settlement | `## Task: <name> — Attempt <N> — <verdict>` block (see shape below) | `settle-attempt-leaf`                 |
| Sprint → review         | `--- *Sprint transitioned to review at <iso>* ---`                  | `transition-sprint-to-review-leaf`    |
| Sprint → done           | `--- *Sprint closed at <iso>* ---`                                  | `close-sprint-leaf`                   |

The sprint header carries only invariant metadata (sprint name, id, ISO created-at). It is **not** a ticket-list
snapshot. `sprint.json` is canonical for tickets; operators wanting the current ticket list read that or look at the
TUI. This keeps progress.md purely append-only with no rewrite seam for `add-tickets` to worry about.

### Task-attempt section shape

```md
## Task: <task-name> — Attempt <N> — <verdict>

_<iso-timestamp>_ — task `<task-id>`, commit `<sha-or-blocked>`

#### Decisions

- ...

#### Changes

- ...

#### Learnings

- ...

#### Notes

- ...

**Verdict:** <pass | blocked> — <short reason>
```

The bullet content comes from the AI's `signals.json` for the round that just
settled. The settle-attempt leaf already has the signals in hand at this point
(it just validated the AI's output per [09](09-ai-session-contract.md)) — no
re-read, no mining.

Empty subsections are **omitted entirely** (no "_no learnings_" placeholder).
Each attempt's section is written once and never edited.

## What this kills

- `src/business/sprint/write-progress-snapshot.ts` — the snapshot renderer.
- `src/business/observability/state-projection.ts` — the chain.log miner.
- `src/integration/persistence/load-chain-log.ts` — chain.log reader.
- `src/integration/persistence/load-decisions-log.ts` — decisions.log reader.
- `src/integration/observability/sinks/file-log-sink.ts` (default-on) — chain.log writer. Becomes opt-in via
  `RALPHCTL_DEBUG_TRACE=1`.
- `src/integration/observability/sinks/decisions-log-sink.ts` — decisions.log writer. Deleted entirely.
- The `<!-- machine:begin -->` ... `<!-- machine:end -->` JSON tail on progress.md. Tools that want machine-readable
  state read `tasks.json` / `execution.json` — those are the canonical sources.
- **`outcome.md` per round** — the journal section IS the per-attempt summary; no need for a sibling file colocated with
  the spawn outputs. Whoever was rendering `outcome.md` in `settle-attempt-leaf` collapses into the journal-append step.

## What replaces them

- A new `progress-journal-leaf` (or extension of `settle-attempt-leaf`) that appends one task-attempt section after
  every settlement. Atomic append via a **new `AppendFile` port** at `src/business/io/append-file.ts` (mirrors
  `WriteFile`). The integration adapter reads existing content, concatenates the new section, writes via
  `writeTextAtomic` (tmpfile + rename) — atomic regardless of size. The per-sprint advisory lock prevents inter-process
  races but the read-concat-rewrite cycle makes the atomicity unconditional.
- A sprint-init step that writes the initial header (once, on sprint creation).
- Status-transition leaves each append their one-line separator via `AppendFile`.

### Why a port, not `fs.appendFile` directly

POSIX `fs.appendFile` is atomic **only up to PIPE_BUF (~4 KiB)**. A task-attempt section with a long critique easily
exceeds that. The read-concat-atomic-rewrite pattern is the safe primitive. Owning it as a port also makes the
journal-append testable: [10](10-leaf-tests-mock-ai.md) leaf tests assert against a recording `AppendFile` fake, no
filesystem I/O.

An ESLint fence (see [09](09-ai-session-contract.md)) blocks direct `fs.appendFile` / `fs.promises.appendFile` outside
`integration/io/`.

### regenerate-progress CLI command: DELETED

Today's `ralphctl sprint regenerate-progress <id>` rebuilds `progress.md` from `chain.log` + `decisions.log` mining —
both deleted. There is no equivalent in the journal model: progress.md _is_ the chronological record, written
incrementally. If it's corrupted, the operator restores from git or backup. No regeneration command is needed.

## AI sees progress.md

Each implement / refine / plan / ideate prompt template includes a section like:

```md
## Prior progress on this sprint

`progress.md` (at the sprint root) records every prior task-attempt on this
sprint in chronological order — decisions made, changes shipped, learnings
recorded, notes pinned. Read it before starting. Honor prior decisions; do
not re-litigate them without a `decision` signal explaining why.
```

### How the AI reaches progress.md (per flow)

| Flow      | cwd                                     | How `progress.md` is reachable                                                                         |
| --------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| implement | the user's repo                         | `--add-dir <sprintDir>` — adds sprintDir as a readable root. progress.md is at the root of that mount. |
| refine    | `<sprintDir>/refinement/<ticket-slug>/` | cwd-relative traversal: `../../progress.md`. No extra `--add-dir` needed.                              |
| plan      | `<sprintDir>/plan/<run-slug>/`          | Same: `../../progress.md`.                                                                             |
| ideate    | `<sprintDir>/ideate/<run-slug>/`        | Same.                                                                                                  |
| readiness | `<sprintDir>/readiness/<repo-id>/`      | Same.                                                                                                  |

The `--add-dir` is **implement-only**. For the other flows, cwd is already inside `<sprintDir>`, so progress.md is
reachable via the traversal. This avoids widening the AI's read access to sibling unit dirs (e.g. refine on ticket A
doesn't need to see refine on ticket B).

## "Updates" — what happens when a task is re-implemented

Tasks can transition back from `blocked` → `todo` (operator intervention) and
re-run. Under the journal model, **the prior attempt's section stays in
progress.md**; a new section is appended for the new attempt. The journal
shows the operator's intervention as a real event in the history:

```md
## Task: refactor-auth — Attempt 1 — blocked

...
**Verdict:** blocked — pre-existing TypeScript error not introduced by this attempt

## Task: refactor-auth — Attempt 2 — pass

...
**Verdict:** pass — commit abc1234
```

This is the right behaviour: the operator can see how the task evolved.

## Open questions

- **Sandbox mount granularity.** Mounting `<sprintDir>` exposes more than progress.md. If we want a tighter boundary,
  we'd have to copy/symlink progress.md into the per-task sandbox on every settlement — adds complexity for marginal
  isolation gain. _Tentative: mount the whole sprintDir; revisit if a real boundary problem surfaces._
- **TUI rendering.** TUI subscribes to bus events for live updates. progress.md is the on-disk view; the TUI doesn't
  read it directly (today the TUI projects from entities + bus events). Confirm during implementation that nothing in
  the TUI reads progress.md and expects projection-shape content.
- **File growth.** A 50-task sprint generates a ~50-section progress.md. Likely well under 1 MiB. No truncation needed;
  if growth becomes a concern, the journal is naturally chunk-able (split on `## Task:` boundaries).

## Action items

- [ ] **Add `AppendFile` port** at `src/business/io/append-file.ts` (signature mirrors `WriteFile`). Integration adapter
      at `src/integration/io/append-file-atomic.ts` does read-concat-`writeTextAtomic`. Wire via `wire()`.
- [ ] Delete the to-be-extinct files (verify actual paths against the codebase at implementation time; the audit's path
      hints may have drifted from real locations): the snapshot renderer, state projection, chain-log loader/parser,
      decisions-log loader/parser, decisions-log sink. The `file-log-sink` stays but becomes opt-in.
- [ ] Make `file-log-sink.ts` opt-in via `RALPHCTL_DEBUG_TRACE=1` — gate in `wire()`. When enabled, writes to
      `<sprintDir>/events.ndjson` (NOT under `logs/`).
- [ ] Land [09](09-ai-session-contract.md) first — appended bullets read from per-spawn `signals.json`, which only
      exists post-[09].
- [ ] Add `progress-journal-leaf` (or fold into `settle-attempt-leaf`) that appends the task-attempt section after every
      settlement using the `AppendFile` port.
- [ ] Move sprint-header writing to a `init-progress-journal-leaf` that fires once at sprint creation. Header omits
      ticket list.
- [ ] **Delete the `ralphctl sprint regenerate-progress` CLI command** — under the journal model there's no rebuild
      path.
- [ ] Add separator-line writes to `activate-sprint-leaf`, `transition-sprint-to-review-leaf`, `close-sprint-leaf`.
- [ ] Add "## Prior progress" section to implement / refine / plan / ideate prompt templates.
- [ ] Update the AI session wiring so `<sprintDir>` is mounted via `--add-dir` on every spawn.
- [ ] Drop the `<!-- machine:begin -->` JSON tail (and any consumer reaching for it — replace with a direct `tasks.json`
      read).
- [ ] Tests: golden-file tests for journal section formatting; integration test that re-implements a blocked task and
      asserts two sections appear in chronological order.
- [ ] Update `.claude/docs/ARCHITECTURE.md` to document the journal model.
