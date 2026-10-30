---
name: lesson_refactor_deleted_predicate_test_inlines_invariant
description: Behaviour-preserving refactors that inline an exported one-line predicate delete its only test; check the invariant is still fenced
metadata:
  type: feedback
---

A "simplification" that inlines an exported pure predicate (e.g. `shouldShowMigrationGate(pending, resolved)`)
and deletes its test removes the only fence for the invariant it named (consent splash must not re-show after
a pause/resume remount). The new inline expression sits in a non-exported closure, so nothing can test it.

**Why:** "tests no weaker" is judged by invariants, not by test count; a tautological-looking test can be the
sole regression net for a launch-path rule.

**How to apply:** for every deleted test file in a refactor diff, name the invariant it guarded and grep
`tests/` for another test that would fail if that invariant broke. Same check for tests deleted because a
re-export was removed (the settings-view provider-list test was fine: the view now imports the domain
constant directly, so the assertion is true by construction).

Other drift classes this refactor style produced (all passed typecheck/lint/tests):

- `Record<string, fn>` dispatch table replacing a `switch`: bracket lookup hits `Object.prototype` keys
  (`constructor`, `toString`) so the "Unknown flow" default is bypassed. Use `Object.hasOwn` or a `Map`.
- Sequential `await`s folded into `Promise.all`: log/warn order becomes completion-order. Grep the diff for
  `Promise.all` and check each for order-dependent side effects.
- Whitelist copy (`pickDefined` / `withDefinedFields`) replaced by rest-spread (`...hints`): extra runtime keys
  and explicit `undefined` values now land on the object. Probe with a tsx script passing `{ ok: true, bogus: 1,
x: undefined }`.
- Boolean flag whose meaning widens when branches are deleted (`compactTwoColumn` became `>= md`, was `md..lg`).
