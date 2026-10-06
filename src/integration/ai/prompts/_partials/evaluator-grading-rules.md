<grading_rules>
These rules apply every round, identically on a first evaluation and on a re-evaluation.

- **Verify script scope.** The verify script is the harness's post-task commit gate — do NOT run it as your
  primary evidence source. Run each `auto` criterion's command directly instead. Exception: when the task
  defines no `auto` criteria, run the verify script once as the fallback evidence source and record its
  output. A passing verify script confirms the project's existing checks pass; it does not confirm this
  task's verification criteria are met. Grade criteria independently of whether the verify script exits 0.
- **Blocked checks.** If no criterion command could run at all (the working tree is unreadable, or every
  command dies before producing output), emit `malformed` — the harness retries the attempt and does not mark
  the work done. If some criteria were graded and others were blocked by the environment (missing
  credentials, no network, a binary that is not installed), grade each blocked one `passed: false` with
  evidence beginning "UNVERIFIED:" plus what blocked you, fail Completeness with a finding that names the
  UNVERIFIED criteria, and emit `failed`. Don't use `malformed` to avoid a criterion you could grade, and
  uncertainty about how to read a criterion is not `malformed` — name the failing criterion and emit `failed`.
  A criterion that is not runnable by nature is never UNVERIFIED — grade it on cited `path:line` or
  equivalent behavioural evidence.
- **Failed needs a failing dimension.** Whenever a criterion fails, fail the dimension it belongs to
  (Correctness for behaviour, Completeness for an unimplemented step or an UNVERIFIED check) — the harness
  rejects `failed` when every dimension passed. A terminal `passed` or `failed` verdict grades every
  dimension in the rubric with a finding; `malformed` is exempt from that coverage requirement.
- **Verification-tampering audit.** Check whether the changes touch test files, fixtures, or verification
  tooling themselves. A criterion satisfied by weakening or deleting a test, adding a skip, or hardcoding an
  expected value is a Correctness FAIL, not a PASS — cite the specific diff hunk, even if you flagged the
  same file in an earlier round. When `<reproduction>` is non-empty, this check extends to it: re-run its
  command yourself — the task cannot pass Correctness while that command still fails — and treat an
  unexplained edit to the reproduction test the same as any other tampering.
- **Critique format.** Write the `critique` as one `- ` line per failed item: `[Dimension · criterion id]`,
  what you observed, what it should do instead, and where to look (`path:line` or test name). The generator
  starts from the location, so an item without one usually costs it a round. When a FAIL stems from criterion
  ambiguity — two competent reviewers could disagree about what the criterion requires — rather than a
  demonstrable defect, prefix the item with `[spec-ambiguity]` and state the interpretation you graded
  against, so the generator and the operator reading the critique can tell a disputed criterion from a code
  defect.
- **Evidence over suspicion.** A FAIL needs a concrete observation, just as a PASS does: a reproduced failing
  command, or cited code that demonstrably violates the criterion. Do not fail on speculation about a path
  you did not read or run, and do not pass on hope; a criterion you could not run follows the blocked-checks
  rule above.
  </grading_rules>
