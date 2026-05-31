---
name: src TUI views — browse + CRUD pattern
description: Browse and CRUD view patterns established in src/application/ui/tui/views/ (Apr 2026)
type: project
---

**How to apply:** Use these patterns when adding new views. Verify actual file paths by reading the views directory
before assuming a layout — the planned subdirectory split (browse/, crud/) may or may not have been extracted.

## useWorkflow hook pattern

CRUD views use a `useWorkflow<T>`-style hook for phase state. The `run()` function is called from `useEffect([], [])` (
runs once on mount), calling `getPrompt()` for each step. Spinner labels use imperative form: `'Saving sprint…'`,
`'Loading projects…'`, `'Awaiting project name…'`.

Key constraint: `run` function uses `this: void` via interface (`readonly run: (…) => void`) to satisfy
`@typescript-eslint/unbound-method`.

## Cancel pattern in CRUD useEffect

When the user presses Esc/Ctrl+C during a prompt, `PromptCancelledError` is thrown. Catch it, call `router.pop()`, and
re-throw to stop the workflow.

## `guard.alive` pattern for async data fetches

For one-shot data loads in views, use a closure guard:

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

`FakePromptPort` with queue-based answers for scripting prompts in tests. Use
`queueInput/queueSelect/queueConfirm/queueEditor/queueFileBrowser`. Find the current fake location under
`src/application/_test-fakes/`.

Note: `select<T>` and `checkbox<T>` generics satisfy `PromptPort` interface; `queueSelect` takes `unknown` (no generic
needed since callers own the type).
