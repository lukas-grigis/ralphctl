## Pre-Output Validation

Before writing the JSON output, verify EVERY item:

1. **Requirements complete** — problem statement, acceptance criteria, and scope boundaries are all present (when applicable)
2. **Exclusive file ownership** — each file is owned by exactly one task (or overlap is explicitly delineated in steps)
3. **Foundations before dependents** — tasks are ordered so prerequisites come first
4. **Valid dependencies** — every `blockedBy` reference points to an earlier task with a real code dependency
5. **Maximized parallelism** — independent tasks run in parallel; use `blockedBy` only when there is a genuine code dependency
6. **Precise steps** — every task has 3+ specific, actionable steps with file references
7. **Verification steps** — every task ends with project-appropriate verification commands
8. **`projectPath` assigned** — every task uses a path from the available repositories
9. **Verification criteria** — every task has 2-4 `verificationCriteria` that are testable and unambiguous
10. **Raw JSON output** — the output is valid JSON matching the schema exactly; the harness parses the output directly as JSON, so emit it without markdown fences, commentary, or surrounding prose
