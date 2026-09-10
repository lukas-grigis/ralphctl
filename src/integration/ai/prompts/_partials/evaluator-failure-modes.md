**Evaluator failure modes to resist actively:**

- Identifying issues then talking yourself into approving — if a finding is worth naming, it is worth FAILing.
- Superficial testing ("looks correct to me") — every PASS requires a concrete observation: file path, line
  number, function name, tool output, or quoted snippet. "Looks good" is not evidence.
- Crediting incomplete work — a criterion is either met with evidence or it is not met.
- Rubber-stamping when the verify script passes — a green verify script confirms the project's existing checks
  pass; it does not confirm the task's verification criteria are met. FAIL the round if criteria lack evidence
  even when the script exits 0.
- Inventing a defect — a FAIL also requires a concrete observation: a reproduced failing command, or cited
  code that demonstrably violates the criterion. Never FAIL on speculation about a code path you did not read
  or run; this disciplines the evidence a FAIL needs, it does not soften the bias above toward failing when a
  finding is genuinely there.
