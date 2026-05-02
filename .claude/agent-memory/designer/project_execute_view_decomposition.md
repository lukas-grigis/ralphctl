---
name: execute-view decomposition (May 2026)
description: Component split + DAG task cards for ExecuteView — patterns established
type: project
---

# ExecuteView Decomposition (May 2026)

`src/application/tui/views/execute-view.tsx` was split from ~750 lines into the orchestrator (~328 lines / 233 code lines) plus an `execute/` component family.

**Why:** The view had grown too large and lacked per-task live signal display.

## Component family: `src/application/tui/components/execute/`

| File                       | Purpose                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `header-heartbeat.tsx`     | Braille spinner in the [RUNNING] header row                                            |
| `step-trace.tsx`           | Outer chain trace (excludes `task-*` steps) — exports `LiveStep` type                  |
| `task-execution-grid.tsx`  | DAG-ordered per-task card grid — exports `TaskGridItem`, `sortByDepth`                 |
| `recent-events-tail.tsx`   | Rolling log-tail panel (receives pre-filtered `LogEvent[]` as prop)                    |
| `feedback-prompt-loop.tsx` | Post-execute feedback IIFE + auto-close — renders `null` (side-effect only)            |
| `flow-context-line.tsx`    | `FlowContextLine` component + `nextStepsForFlow` helper function                       |
| `ctx-helpers.ts`           | Duck-typed ctx extractors: `getTaskList`, `buildTaskNameLookup`, `getExecuteCtxFields` |

## DAG ordering algorithm

`sortByDepth` in `task-execution-grid.tsx`:

1. BFS from roots (tasks with no deps in the current list)
2. Assign depth = `1 + max(dep.depth)` per task (visit() recursion with cycle detection)
3. Sort ascending by depth, then by id within each layer
4. On cycle detection: return null → fall back to insertion order (no crash)
5. Each card is indented by `spacing.indent * depth` to visually trace chains

## Per-task signal wiring

`execute-view.tsx` subscribes to `signalBus.subscribe()` and maintains a
`Map<taskId, HarnessSignal>` in state. When `event.type === 'signal' && event.taskId` arrives,
the map is updated. The map is passed to `TaskExecutionGrid` as `taskSignals`. When `null`
(no bus wired), activity lines are hidden — graceful degrade.

## Key patterns

- `FeedbackPromptLoop` renders `null` — pure side-effect component. Guards with `feedbackPromptedFor` ref to fire exactly once per settled session.
- `LiveStep` type is exported from `step-trace.tsx` and imported by `flow-context-line.tsx` + `execute-view.tsx` directly (no barrel).
- `ctx-helpers.ts` uses duck-typing (`unknown` input) to avoid hard imports on execute chain types.
- `'todo' | 'in_progress' | 'done' | 'blocked' | string` union triggers `@typescript-eslint/no-redundant-type-constituents` — use `string` only for the status field in `TaskGridItem`.

**How to apply:** When decomposing a large view, extract side-effect-only logic as `null`-returning components. Extract data helpers to a `*-helpers.ts` file. Keep shared types in the most specific component file and import directly.
