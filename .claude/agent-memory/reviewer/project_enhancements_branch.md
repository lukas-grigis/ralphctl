---
name: feature/enhancements branch context
description: Context from review of ralphctl/20260502-111643-graph-view — context-file handoff, DAG graph view
type: project
---

Branch `feature/enhance` — reviewing commit-2 of 5 (2026-05-03). Typecheck clean, lint clean. 4 pre-existing TUI test failures remain (home-view-workflow, home-view-sprint-summary, view-shell) — all present before commit-2 staged diff; commit-2 reduces total failure count from ~13 to 4.

**Commit 1: fix(prompts+execute): one-file handoff + linearize execution + drop dead branches**

Key changes shipped and confirmed correct:

1. `render-prompt-to-file` leaf + `WriteContextFilePort` + `FileWriteContextFileAdapter`
2. `renderFileHandoffWrapper` in `business/usecases/_shared/file-handoff-wrapper.ts`
3. `executeFlow` linearised: `Parallel` removed, `Sequential` of topologically-ordered per-task chains
4. Per-task step trace: `branch-preflight → mark-in-progress → render-prompt-to-file → execute-task → post-task-check → evaluate-task → mark-done`
5. `recover-dirty-tree` dropped (evaluator catches dirty trees as Completeness failure)
6. `BundledSkillsCopier` (copy-then-rm) replaces old symlink-based skills adapter
7. `resolve-branch` leaf added to outer execute-flow for idempotent branch strategy prompt

**Architecture findings — NOT violations:**

- `render-prompt-to-file` and `per-task-flow` import `resolveStoragePaths` from `integration/persistence/storage-paths.ts` directly. This is pre-existing pattern (application/ may import integration/) — not a violation.
- Direct `typescript-result` imports in test files only — pre-existing, not introduced by this commit.

**Confirmed correct:**

- `taskBlocked` guard fires BEFORE `promptFilePath === undefined` guard in `execute-task` and `evaluate-task` leaves — no phantom path error possible on blocked tasks
- `render-prompt-to-file` returns `input.path` (a real computed path) even on skip/blocked — downstream leaves skip on `taskBlocked` before reading it
- `feedback-flow` apply-feedback leaf guards `feedbackText.length === 0` BEFORE `promptFilePath === undefined` — consistent with the skip() contract on the render leaf
- `assertTasksAcyclicLeaf` captures `sortResult` at factory time (closure) — runtime leaf just reflects the pre-computed outcome

**Why:** The 0.6.0 rewrite added steps that docs haven't caught up to. Tests assert the correct (fuller) step traces.

**How to apply:** Reference when reviewing future chain or context-file work. Commit-1 is ship-ready.

**Commit 2: refactor(kernel+evaluate): live ctx via ChainRunner.onCtxUpdate; route Ctrl+C through evaluator**

Key changes:

1. `OnCtxUpdateCallback<TCtx>` added to `Element.execute` / `run` signature; propagated through Sequential/Retry/OnError/Leaf.
2. `runLeaf` calls `onCtxUpdate?.(successCtx)` BEFORE `onTrace?.(entry)` — correct ordering.
3. `ChainRunner` wires `onCtxUpdate` into `currentCtx` so `runner.ctx` is live mid-flight.
4. `check-already-evaluated` now sets `ctx.skipEvaluation: boolean` (flag) instead of throwing `NotFoundError` — evaluator never blocks.
5. `render-prompt-to-file`, `evaluate-task`, `persist-evaluation` all guard on `skipEvaluation` flag.
6. Evaluator OnError fence: `catchIf: err => err.code !== 'aborted'` — aborted propagates, everything else noops.
7. `EvaluateTaskUseCase` drops `PromptBuilderPort` (prompt rendering moved to chain layer / loop).
8. `EvaluateAndFixLoopUseCase` gains `prompts` + `writeContextFile` + `contextsDir` + `executePromptFilePath`.
9. Dead `autoCommit` knob removed from loop.

**Architecture confirmed correct for commit-2.**
