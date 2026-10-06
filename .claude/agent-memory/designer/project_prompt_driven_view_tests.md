---
name: project-prompt-driven-view-tests
description: Testing a view that asks through the prompt queue — harness traps (eventBus stub blanks the frame, PromptHost body wrap, optional queue)
metadata:
  type: project
---

Views that ask via `createInkInteractivePrompt(queue)` are tested by rendering `<View/><PromptHost queue={queue}/>` under `renderView(..., { queue })`.

- A stub `deps.eventBus = { publish }` blanks the whole frame (something subscribes to it); omit it — the adapter takes the bus optionally.
- `ScrollableMessage` hard-wraps body lines at ~92 cols, so a stash key holding two full UUIDs breaks mid-word; assert on short fragments, not the key.
- `useUnblockTask` uses `useOptionalPromptQueue`: bare view renders (e.g. ExecuteBody tests) mount no queue provider and must not throw.

**Why:** each cost a debugging loop. **How to apply:** copy `tests/integration/application/ui/tui/views/sprint-detail-unblock-prior-work.test.tsx` for the next prompt-driven flow.
