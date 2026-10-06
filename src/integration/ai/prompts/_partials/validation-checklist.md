<validation-checklist>

## Pre-Output Validation

Before presenting the plan, verify every item — and again if anything changes before you write the output:

1. **Requirements understood** — every requirement in scope is reflected in at least one task; nothing in scope is dropped.
2. **Shared files are sequenced** — when two tasks edit the same file, one is `blockedBy` the other so they
   never run in parallel; otherwise give each file to one task.
3. **Foundations before dependents** — order tasks so prerequisites come first; `blockedBy` reflects genuine code
   coupling or a shared file, not arbitrary preference.
4. **Valid `blockedBy` references** — every id in `blockedBy` matches an earlier task's `id` placeholder; no
   self-edges; no cycles.
5. **Precise steps** — each task has 2–8 specific, actionable steps. Each step references concrete files or
   functions; "implement the feature" is not a step.
6. **Verification criteria** — each task has 2–4 `verificationCriteria` that are testable and unambiguous.
   "Tests pass" alone is too vague — name the behaviour or invariant that proves the task is done.
7. **Repository assignment** — every task's `projectPath` matches one of the repository paths provided above.
8. **Signal output only** — the task array goes into the output signal named in your output contract below as JSON.
   In chat you present it as the readable plan; only the signal file is read by the harness.
9. **Unique placeholder ids** — each task's `id` is a unique string within this array (used only for
   `blockedBy` resolution; the harness assigns persistent ids on save).
10. **Deterministic checks** — the `auto`-criterion rule from the task fields holds for every task.

</validation-checklist>
