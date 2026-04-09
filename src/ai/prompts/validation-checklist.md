## Pre-Output Validation

Before writing the JSON output, verify EVERY item:

1. **Requirements complete** — Problem statement, acceptance criteria, and scope boundaries are all present (when applicable)
2. **No file overlap** — No two tasks modify the same files (or overlap is explicitly delineated in steps)
3. **Foundations before dependents** — Tasks are ordered so prerequisites come first
4. **Valid dependencies** — All `blockedBy` references point to earlier tasks with real code dependencies
5. **Maximized parallelism** — Independent tasks do NOT block each other unnecessarily
6. **Precise steps** — Every task has 3+ specific, actionable steps with file references
7. **Verification steps** — Every task ends with project-appropriate verification commands
8. **`projectPath` assigned** — Every task uses a path from the available repositories
9. **Verification criteria** — Every task has 2-4 `verificationCriteria` that are testable and unambiguous
10. **Output format compliance** — Output matches the schema exactly: no markdown fences around JSON, no commentary, no surrounding text. The harness parses raw output as JSON.
