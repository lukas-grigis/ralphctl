---
name: lesson_data_driven_branch_loses_coverage
description: A helper that closes over a const data table loses branch coverage when a data edit removes the only triggering row; tests get deleted as "no longer reachable"
metadata:
  type: feedback
---

When a helper reads a module-level table directly (e.g. `unambiguousRetiredSuccessor` over `RETIRED_MODEL_REMAPS`),
its tests can only exercise branches the current data triggers. A data refresh that retargets the last row feeding a
branch (two providers retiring one slug onto the same successor) makes the implementer delete that test, and the
branch is then live code with zero coverage — a mutation like `Set.size === 1` → `array.length === 1` passes.

**Why:** the gate stays green and the deleted test looks like honest cleanup ("no data row triggers it any more").

**How to apply:** for every deleted test in a data-refresh diff, group the table by the branch's key (tsx probe over
the real constant) to confirm whether any row still reaches it; if none does, report it as a test-gap with the
surviving mutation, and name the smallest re-arm (a property test over the table, or a defaulted table parameter).
Related: [[lesson_refactor_deleted_predicate_test_inlines_invariant]], [[model-bump-drift-grep-list]].
