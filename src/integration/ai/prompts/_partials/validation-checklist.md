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
8. **Signal output only** — the task array goes into the `tasksJson` field of the `task-plan` signal written
   to `signals.json`. Do not emit the JSON array as prose or inside markdown fences — only the signal file
   is read by the harness.
9. **Unique placeholder ids** — each task's `id` is a unique string within this array (used only for
   `blockedBy` resolution; the harness assigns persistent ids on save).
10. **Deterministic checks preferred** — each task includes at least one `auto` criterion when the
    repository exposes a check command (test, typecheck, lint, or build). A task that relies solely on
    `manual` criteria is acceptable only when it is pure documentation or investigation work with no
    code change to check.

</validation-checklist>
