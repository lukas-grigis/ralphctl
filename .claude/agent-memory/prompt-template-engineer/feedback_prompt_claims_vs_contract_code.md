---
name: prompt-claims-vs-contract-code
description: A prompt sentence about what the harness does with the AI's output must be checked against the leaf's contract code, and the test that pins it must pin the truth
metadata:
  type: feedback
---

Before writing or keeping a sentence like "X fails validation" / "the harness commits Y" / "triggers a retry",
read the leaf's `*.contract.ts` (and the flow, for retries) and state what the code does.

**Why:** apply-feedback told the model any extra signal "fails validation of the whole file", but the review
contract filters non-terminal entries out before validating — they are silently discarded. The false claim
had a test pinning its wording, so it survived a prompt pass. The corrective-retry loop likewise exists only for
the implement flow's generator/evaluator spawns; interactive plan and ideate have none, so "triggers the retry"
was wrong for them.

**How to apply:** when a pinning test asserts harness-behaviour wording, assert the true verb ("discarded") and
add a `not.toContain` on the false one. A discarded signal never reaches the operator, so point must-see items at
a field the terminal signal actually carries (`task-complete` has no text field; `task-blocked` has `reason`).
