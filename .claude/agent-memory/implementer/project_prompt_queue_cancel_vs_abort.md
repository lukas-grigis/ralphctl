---
name: prompt-queue-cancel-vs-abort
description: TUI prompt-queue esc-cancel/shutdown reject with PLAIN Error, never AbortError — so a blanket .catch around prompt promises can safely re-throw AbortError
metadata:
  type: project
---

The TUI prompt-queue distinguishes user-cancel from chain-abort by error CLASS, and this is what
makes "re-throw AbortError, swallow the rest" safe in any `.catch` wrapping a prompt promise.

- esc-cancel of a single prompt → `prompt-host.tsx` `rejectHead(new Error('cancelled by user'))` —
  a PLAIN `Error`, NOT an `AbortError`.
- TUI shutdown → `launch.ts` `queue.drain(new Error('TUI shutting down'))` — also a plain `Error`.
- `AbortError` (`src/domain/value/error/abort-error.ts`, code `aborted`) is ONLY the chain-runtime
  cancellation error; nothing in the prompt path produces it.

**Why:** The project rule "a blanket promise `.catch` MUST re-throw AbortError" (CLAUDE.md) looks
like it would break the silent esc-cancel-swallow in `use-edit-field.ts`'s blanket catch. It does
NOT — because esc rejects with a plain Error, `if (cause instanceof AbortError) throw cause; else
swallow` keeps esc silent while letting a real abort propagate.

**How to apply:** When adding/reviewing a `.catch` around any `queue.enqueue(...)` promise or
`openEditPrompt(...)` (single-option fast path AND multi-option field-picker in
`field-editors.ts`), gate the swallow on `instanceof AbortError`. The two seams are independent:
`use-edit-field.ts` guards the edit TEXT prompt; `field-editors.ts`'s `.catch` guards the field-
PICKER choice prompt — the latter is NOT made redundant by fixing the former. See
[[recoverable-turn-error-policy]] for the analogous "Aborted always propagates, recoverable errors
get handled" split one layer down.
