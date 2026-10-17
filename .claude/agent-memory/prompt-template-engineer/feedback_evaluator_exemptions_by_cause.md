---
name: evaluator-exemptions-by-cause
description: Evaluator "pre-existing" exemptions must be keyed on whether the change caused the defect, not on which code it touched; every restatement of the FAIL rule needs the same exception
metadata:
  type: feedback
---

An exemption phrased by code location ("code the change neither touches nor newly depends on") lets an
evaluator label an untouched caller that the change breaks as pre-existing — the caller already depended on the
function. Phrase it as "a defect the change did not cause" and widen the FAIL side to "existing code the change
breaks".

**Why:** the eval fixture where a new default silently changes an untouched caller is exactly that case. Only the
criterion clause and "unsure counts as the change's own" were guarding it.

**How to apply:** the FAIL scope and the exemption must be complements, otherwise a case falls in the gap. The
floor rubric's verdict line ("FAIL when any check fails") is a second statement of the rule, rendered next to the
exemption, so it names the exception inline too. Tests pin both prompts that share the partial. The worked
example's "neither touches nor calls it" stays — it is evidence of non-causation, not the test.
