# 05 — `done-criteria.md` — delete it

**Status:** decided-change (2026-05-22)
**Related:
** [01 logs dir](01-logs-directory-layout.md), [08 prompt ↔ done-criteria coupling](08-prompt-done-criteria-coupling.md)

## Decision

Delete `done-criteria.md` from the per-task workspace. The criteria live in two places only:

| Layer      | Form                                                    | Role                                                                                                                                                 |
| ---------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source** | `Task.verificationCriteria` (in `tasks.json`)           | Canonical state — the only place the criteria are actually stored.                                                                                   |
| **Target** | Rendered `prompt.md` (generator + evaluator, per round) | What the AI sees. Substituted via `{{VERIFICATION_CRITERIA_SECTION}}` at spawn time. The on-disk prompt.md preserves the framing the AI was held to. |

TUI renders from `Task.verificationCriteria` directly — the Task is already in memory; no extra disk read. Operators who
want the on-disk version look at `prompt.md` (which contains the inlined criteria block).

## What's deleted

- The `done-criteria.md` writer in `build-task-workspace.ts:52–101` (and the per-task file itself).
- The `ReadDoneCriteria` port and its filesystem adapter (`src/application/bootstrap/wire.ts:173–178`).
- The async lazy-read in the TUI Tasks panel (`src/application/ui/tui/components/tasks-panel.tsx:102–115`) — replaced by
  a synchronous render from `Task.verificationCriteria`.

## What stays

- `{{VERIFICATION_CRITERIA_SECTION}}` substitution in the generator and evaluator prompt templates — unchanged.
- The rendered `prompt.md` files under `rounds/<N>/<role>/` — these are the per-round audit trail of what the AI was
  held to.
- `Task.verificationCriteria` — canonical, edited via the refine / plan flows.

## Why this is fine

1. **Audit decoupling still works.** Concerned about scope drift if a task is edited between runs? The `prompt.md` from
   the prior run still exists with the prior criteria inlined. Same audit guarantee, fewer files.
2. **Sandbox completeness still works.** The AI's sandbox dir contains `prompt.md` with the criteria block. Zipping the
   dir for a bug report still includes everything the AI was told.
3. **TUI performance is the same or better.** Reading `Task.verificationCriteria` from in-memory state beats an async
   filesystem read. The lazy-load was solving a problem (re-parsing `tasks.json` during the loop) that didn't actually
   exist — the Task is already projected into TUI state.
4. **One less file in the per-task dir.** Fewer paths to explain to a new operator.

## What changes for the operator

Before:

- `<sprintDir>/implement/<task-id>/done-criteria.md` — bullets only, single file
- TUI `e` hotkey: opens that file

After:

- TUI `e` hotkey: renders the bullets from in-memory `Task.verificationCriteria` (same visual; no I/O hop)
- Operator who wants the criteria on disk: look at `<sprintDir>/implement/<task-id>/rounds/<N>/<role>/prompt.md` — the
  criteria block is inside, with a stable `## Done criteria` header for `grep` / scroll affordance.

## Action items

- [ ] Delete `done-criteria.md` writer + `ReadDoneCriteria` port + filesystem adapter.
- [ ] Convert TUI Tasks panel to render `Task.verificationCriteria` synchronously.
- [ ] Confirm the prompt template's `{{VERIFICATION_CRITERIA_SECTION}}` is rendered with a stable `## Done criteria`
      heading so `grep` against `prompt.md` finds it cleanly.
- [ ] Update CLAUDE.md to drop the `done-criteria.md` reference in the sandbox-layout paragraph (line 212-ish).
- [ ] Update [01](01-logs-directory-layout.md) layout to remove `done-criteria.md` from the per-task tree.
- [ ] Update [08](08-prompt-done-criteria-coupling.md) — "three places" becomes "two places" (source + target).

## Why the old "decided-keep" was wrong

The previous reasoning leaned on three things:

1. **TUI lazy-load** — but the TUI already has the Task object, so the load was solving a non-problem.
2. **Audit decoupling** — but `prompt.md` already serves this role with the criteria inlined.
3. **Sandbox completeness** — but `prompt.md` is in the sandbox.

All three benefits are preserved without the standalone file. The duplication
(three places for the same data) was the actual cost; the file was the cheapest
to delete.
