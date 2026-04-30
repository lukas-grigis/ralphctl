---
name: src TUI views — browse + CRUD pattern
description: Browse and CRUD view implementations in src/application/tui/views/ shipped Apr 2026
type: project
---

All PlaceholderView stubs replaced with real views in the Apr 2026 follow-up task.

**Why:** Foundation task shipped router + components but left 9 ViewId stubs as PlaceholderView.

**How to apply:** Use these patterns when adding new views.

## View layout

```
src/application/tui/views/
  browse/
    sprint-list-view.tsx        sprint-show-view.tsx
    ticket-list-view.tsx        project-list-view.tsx
    project-show-view.tsx       task-list-view.tsx
  crud/
    sprint-create-view.tsx      sprint-close-view.tsx     sprint-remove-view.tsx
    ticket-add-view.tsx         ticket-edit-view.tsx      ticket-remove-view.tsx
    project-add-view.tsx        project-edit-view.tsx     project-remove-view.tsx
    project-repo-add-view.tsx   project-repo-remove-view.tsx
    task-add-view.tsx           task-edit-status-view.tsx task-remove-view.tsx
  components/
    use-workflow.ts             (shared hook for CRUD phase state)
  home-view.tsx                 (updated with sprint summary + full menu)
  router-context.ts             (25 ViewIds total)
  view-router.tsx               (registry: all 25 wired)
```

## useWorkflow hook pattern (src/application/tui/components/use-workflow.ts)

CRUD views all use `useWorkflow<T>` for phase state. The `run()` function is called from `useEffect([], [])` (runs once on mount), calling `getPrompt()` for each step. Spinner labels use imperative form: `'Saving sprint…'`, `'Loading projects…'`, `'Awaiting project name…'`.

Key constraint: `run` function uses `this: void` via interface (`readonly run: (…) => void`) to satisfy `@typescript-eslint/unbound-method`.

## Cancel pattern in CRUD useEffect

When the user presses Esc/Ctrl+C during a prompt, `PromptCancelledError` is thrown. Catch it, call `router.pop()`, and re-throw to stop the workflow.

## `guard.alive` pattern for async data fetches

For home-view sprint summary (and similar one-shot data loads), use a closure variable + function:

```ts
let alive = true;
const isAlive = (): boolean => alive;
void (async () => {
  …
  if (!isAlive()) return;
  …
})();
return () => { alive = false; };
```

## Test fakes

`src/application/_test-fakes/fake-prompt-port.ts` — FakePromptPort with queue-based answers for scripting prompts in tests. Use `queueInput/queueSelect/queueConfirm/queueEditor/queueFileBrowser`.

Note: `select<T>` and `checkbox<T>` generics satisfy `PromptPort` interface; `queueSelect` takes `unknown` (no generic needed since callers own the type).

## ViewId count

25 total: home, settings, dashboard, execute, sessions + 20 new browse/CRUD views.
