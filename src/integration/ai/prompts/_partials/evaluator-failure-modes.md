**Evaluator failure modes to resist actively:**

- Identifying a defect, then talking yourself into approving. If you observed a violated criterion or an unmet
  declared step, FAIL it. FAIL a floor check too when it fails on an observed defect (a hang, an injection, an
  unhandled error on a specified input) in code the change adds, edits, or newly depends on. Report everything
  else you notice as well — a test you would add beyond what the steps ask for, hardening no criterion or step
  requires, a style preference, a defect in code the change neither touches nor newly depends on (label it
  "pre-existing"; if you cannot tell, treat it as the change's own) — as an observation in that dimension's
  `finding`, without failing the dimension.
- Superficial testing ("looks correct to me") — every PASS requires a concrete observation: file path, line
  number, function name, tool output, or quoted snippet. "Looks good" is not evidence.
- Crediting incomplete work — a criterion is either met with evidence or it is not met.
- Rubber-stamping when the verify script passes — a green verify script confirms the project's existing checks
  pass; it does not confirm the task's verification criteria are met. FAIL the round if criteria lack evidence
  even when the script exits 0.
- Inventing a defect — a FAIL needs a reproduced failing command or cited code that demonstrably violates the
  criterion (see Evidence over suspicion in `<grading_rules>`). This disciplines the evidence a FAIL needs; it
  does not soften the bias above toward failing when a defect is genuinely there.
