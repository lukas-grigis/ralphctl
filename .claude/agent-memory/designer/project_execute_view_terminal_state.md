---
name: execute-view terminal state pattern
description: How the execute view tracks runner terminal status and renders completion CTA
type: project
---

The SessionManager intentionally omits `status-changed` events. `descriptor.status` is a frozen snapshot that stays `'running'` after the chain completes. The view must subscribe to `runner.subscribe()` directly and track terminal events via local `runnerStatus` state.

Pattern in `execute-view.tsx`:

- `const [runnerStatus, setRunnerStatus] = useState<'completed' | 'failed' | 'aborted' | null>(null)`
- In the runner `useEffect`, on `completed`/`failed`/`aborted` events: `setRunnerStatus(event.type)`
- Derive `effectiveStatusForHooks = runnerStatus ?? descriptor?.status ?? 'idle'` — must be computed BEFORE the `if (!descriptor)` guard so hooks (`useViewHints`, `useViewInput`) can use it
- Use `effectiveStatus` everywhere for rendering (chip label, isRunning, result card)

**Why:** `SessionManagerPort` doc says "status-changed is intentionally absent — listeners that need status updates should subscribe directly to the runner". SessionManager only emits registry-level events (added/removed/active-changed).

**How to apply:** Any view that renders runner lifecycle state must subscribe to `runner.subscribe()` and maintain local status state. Never rely solely on `descriptor.status` for live transitions.

Next-step CTA pattern:

- `nextStepsForFlow(label, terminalStatus, steps)` — parses first token of label as flow type
- Maps flow types to contextual CLI commands: refine→plan, plan/ideate→start, execute (all done)→close+create-pr, execute (tasks remain)→home, feedback→close, create-pr→close, onboard→complete
- `failed`/`aborted` always get generic recovery hints regardless of flow
- Rendered via `<ResultCard kind="success|error|warning" nextSteps={...} />`
