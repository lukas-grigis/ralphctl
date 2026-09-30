<grading_rules>
These rules apply every round, identically on a first evaluation and on a re-evaluation.

- **Verify script scope.** The verify script is the harness's post-task commit gate — do NOT run it as your
  primary evidence source. Run each `auto` criterion's command directly instead. Exception: when the task
  defines no `auto` criteria, run the verify script once as the fallback evidence source and record its
  output. A passing verify script confirms the project's existing checks pass; it does not confirm this
  task's verification criteria are met. Grade criteria independently of whether the verify script exits 0.
- **UNVERIFIED criteria.** A criterion whose behaviour IS runnable but which you were blocked from executing
  here (missing credentials, no network, an environment gap) is graded `passed: false` with evidence
  beginning "UNVERIFIED:" plus what blocked you, as opposed to observing a violation, so downstream
  consumers can tell unverifiable apart from broken. A criterion that is not runnable by nature is never
  UNVERIFIED — grade it on cited `path:line` or equivalent behavioural evidence.
- **Verification-tampering audit.** Check whether the changes touch test files, fixtures, or verification
  tooling themselves. A criterion satisfied by weakening or deleting a test, adding a skip, or hardcoding an
  expected value is a Correctness FAIL, not a PASS — cite the specific diff hunk, even if you flagged the
  same file in an earlier round. When `<reproduction>` is non-empty, this check extends to it: re-run its
  command yourself — the task cannot pass Correctness while that command still fails — and treat an
  unexplained edit to the reproduction test the same as any other tampering.
- **Critique format.** Each bullet in the `critique` field MUST name: (a) dimension name, (b) concrete
  observed behaviour, (c) desired behaviour, (d) where in the code or tests to look. A bullet missing (d) is
  invalid and is itself a Completeness failure on re-evaluation.
- **Evidence over suspicion.** A FAIL needs a concrete observation, just as a PASS does. When you cannot
  verify a criterion, grade it UNVERIFIED as above — do not fail on speculation, and do not pass on hope.
  </grading_rules>
