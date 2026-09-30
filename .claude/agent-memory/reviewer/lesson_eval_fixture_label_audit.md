---
name: lesson_eval_fixture_label_audit
description: `pnpm eval check` proves only that the oracle separates the variants — audit each spec clause against the clean/reference variant and each oracle assert against a spec-literal alternative
metadata:
  type: feedback
---

`pnpm eval check` (26/26 green) proves the hidden oracle fails the defect and passes the clean variant.
It does not prove that the clean variant meets the whole task description, or that the oracle accepts every
implementation that meets it. Three bug classes got past it:

1. **Clean variant breaks a spec clause the oracle doesn't assert.** The spec said "any other failure
   throws an Error whose message contains the path". The clean variant rethrew the raw `EISDIR` error, whose
   message has no path, and the oracle's directory case only checked `assert.throws`. An evaluator that
   probes a directory is right to FAIL "clean", and the harness then scores that as a false-FAIL.
   **How to apply:** list every sentence of `task.description` and run each one against the clean variant
   in a scratch workspace (`git apply` the patch onto a copy of `repo/`). Node's error messages differ:
   `EACCES` includes the path, `EISDIR` doesn't.
2. **The oracle over-specifies the spec (implement flow).** The spec said "throws a RangeError", but the
   oracle used `assert.rejects(fn(...))`. A synchronous throw escapes before `assert.rejects` runs, so a
   spec-literal solution fails. `assert.rejects(async () => fn(...))` accepts both. Watch for the same thing
   in `peak === limit` checks, where the spec says "at most".
   **How to apply:** for each implement oracle assert, write the most literal alternative implementation
   and run the oracle on it.
3. **Tells in the defect diff.** One defect carried `// eslint-disable-next-line no-unused-vars` on the very
   parameter it failed to use, in a repo with no ESLint. That makes a capability item trivial. Grep defect
   patches for lint suppressions, TODOs and comments that describe the defect.

Related: [[lesson_ab_harness_review_checks]], [[lesson_tocontain_ignores_asymmetric_matchers]].
