---
name: ralphctl-code-simplification
description: Behaviour-preserving simplification of existing code — understand why the code exists before changing it, then reduce nesting, unclear names, duplication, dead code, and needless indirection one step at a time with the existing tests unchanged and green after each. Use when a task asks to refactor or clean up working code, or when code you just made work is heavier than it needs to be; for keeping a new change small from the start, see ralphctl-surgical-simplicity and ralphctl-ponytail when installed.
license: MIT
---

# Code Simplification

> Adapted from [addyosmani/agent-skills — "Code Simplification"](https://github.com/addyosmani/agent-skills)
> (MIT). Adapted for ralphctl's harness contract.

Simplify by reducing complexity while preserving behaviour exactly. The goal is not fewer lines — it is
code a new reader understands faster than the original. Every simplification passes one test: would
someone new to this code follow the result more easily?

## When this applies

- **Execute** — when the task asks for a refactor or cleanup, and after a change works, on the code that
  change touched. Simplification outside the task's scope is a finding to surface, not an edit to make —
  record it in a `note` signal when the prompt's output-contract section lists it; otherwise fold it into
  the required signal's own fields.

**When not to use:** the code is already clear; you do not yet understand what it does; the simpler form
is measurably slower on a hot path; the module is about to be replaced.

## Principles

1. **Preserve behaviour exactly.** Same outputs for every input, same errors, same side effects and their
   order. The existing tests pass without modification. If you are not sure a change preserves
   behaviour, do not make it.
2. **Follow the project's conventions.** Read the project's context file when present and the
   neighbouring code; simplification that breaks local consistency is churn.
3. **Clarity over cleverness.** A chain of nested conditional expressions becomes early returns or a
   lookup; a dense chained transform with inline logic becomes a named intermediate step.
4. **Keep the balance.** Do not inline a helper that gives a concept its name, merge unrelated logic into
   one function, or remove an abstraction that exists for testability. Line count is not the measure.
5. **Scope to what changed.** Default to the code the task touched.

## The process

### 1. Understand before touching (Chesterton's fence)

Before changing or removing anything, know why it exists: its responsibility, its callers and callees,
its edge cases and error paths, the tests that pin its behaviour, and why it might have been written this
way (a performance constraint, a platform quirk, history visible in `git log` or `git blame`). If you
cannot answer these, read more first.

### 2. Find concrete opportunities

| Pattern                              | Simplification                                        |
| ------------------------------------ | ----------------------------------------------------- |
| Nesting three or more levels deep    | Guard clauses or an extracted, well-named condition   |
| A long function doing several jobs   | Split by job, never by line count                     |
| Boolean flag parameters              | Separate functions, or a named options value          |
| The same condition in several places | One named predicate                                   |
| Generic or misleading names          | Names that describe the content or the real behaviour |
| A comment explaining _what_          | Delete it; keep comments that explain _why_           |
| Duplicated logic                     | One shared function                                   |
| Dead code                            | Remove it, after confirming nothing reaches it        |
| A wrapper that only forwards         | Call the underlying function directly                 |
| An abstraction with one variant      | The direct approach                                   |

### 3. Apply one change at a time

Make one simplification, run the focused tests, and continue only when they are green; when they fail,
undo that step and reconsider. Never batch several simplifications into one untested change — when
something breaks, you need to know which one did it. Keep refactoring and behaviour change apart: a
refactor task adds no behaviour, and a feature task does not absorb a broad refactor. For a change
touching many sites, prefer a mechanical transform (a structured search-and-replace or a codemod the
project already uses) over hand edits.

### 4. Judge the whole

Compare before and after: is the result genuinely easier to follow, consistent with the codebase, and a
clean reviewable diff? If not, undo it. Not every attempt succeeds.

## Common rationalisations

| Rationalisation                          | Reality                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| "Fewer lines is always simpler"          | A one-line nested conditional is not simpler than five readable lines.            |
| "I'll quickly tidy this unrelated code"  | Unscoped cleanup inflates the diff and risks regressions you did not intend.      |
| "This abstraction might be useful later" | Speculative abstractions are complexity without value. Remove it; re-add on need. |
| "The tests needed a small tweak"         | A simplification that needs test changes probably changed behaviour.              |

## Red flags

- Tests modified to make a "simplification" pass.
- A "simplified" version that is longer or harder to follow.
- Renames that follow your preference rather than the project's conventions.
- Error handling removed because it "looked noisy".
- Simplifying code you do not fully understand.

## Self-check

- [ ] The existing tests pass without modification.
- [ ] No error handling was removed or weakened.
- [ ] The result follows the project's conventions.
- [ ] No dead code was left behind (unused imports, unreachable branches).
- [ ] The diff stays inside the task's scope.
