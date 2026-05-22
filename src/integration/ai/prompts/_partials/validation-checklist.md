<validation-checklist>

## Pre-Output Validation

Before writing the JSON output, verify EVERY item:

1. **Requirements understood** — every approved ticket is reflected in at least one task; nothing in scope is dropped.
2. **Exclusive file ownership** — each file is owned by exactly one task. When two tasks must edit the same file,
   make the relationship explicit via `blockedBy` so they run in sequence, not in parallel.
3. **Foundations before dependents** — order tasks so prerequisites come first; `blockedBy` reflects genuine code
   coupling, not arbitrary preference.
4. **Valid `blockedBy` references** — every id in `blockedBy` matches an earlier task's `id` placeholder; no
   self-edges; no cycles.
5. **Precise steps** — each task has 2–8 specific, actionable steps. Each step references concrete files or
   functions; "implement the feature" is not a step.
6. **Verification criteria** — each task has 2–4 `verificationCriteria` that are testable and unambiguous.
   "Tests pass" alone is too vague — name the behaviour or invariant that proves the task is done.
7. **Repository assignment** — every task's `projectPath` matches one of the absolute paths listed under
   "Selected repositories" above.
8. **Raw JSON output** — output a single JSON array matching the Task schema. The harness parses your output
   directly; emit it without markdown fences, commentary, or surrounding prose.
9. **Unique placeholder ids** — each task's `id` is a unique string within this array (used only for
   `dependsOn` resolution; the harness assigns persistent ids on save).

</validation-checklist>
