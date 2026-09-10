Each task entry uses these fields:

- **`id`** — short, stable string used only for `blockedBy` references within this array (e.g.
  `"1"`, `"T1"`, `"api-shape"`).
- **`name`** — imperative verb phrase, short (e.g. `"Wire CSV export endpoint"`).
- **`description`** — optional longer-form context; include only when `name` leaves important
  ambiguity.
- **`projectPath`** — absolute path matching exactly one of the repositories listed under
  `<repositories>`.
- **`steps`** — concrete, ordered implementation steps. Do NOT end steps with "run the
  verification commands" or "run all the checks" — verification belongs in `verificationCriteria`;
  the harness and the evaluator execute it. A final step that re-runs the full suite only
  duplicates the post-task gate and inflates generator cost. Exception: a step MAY run a specific
  check when a later step depends on its output (e.g. "run the migration dry-run and confirm the
  schema diff before writing the rollback script").
- **`verificationCriteria`** — array of structured criteria the evaluator grades PASS / FAIL:
  - `id` — stable within the task (e.g. `"C1"`); the evaluator cites it verbatim.
  - `assertion` — human-readable check.
  - `check` — `"auto"` (evaluator runs `command`) or `"manual"` (evaluator inspects code or
    behaviour and cites a specific location).
  - `command` — REQUIRED when `check === "auto"`; MUST be omitted when `check === "manual"`. Use
    the project's own commands — never hardcode a package-manager binary; read the project's
    manifest or context file for the actual command.
  - Include at least one `auto` criterion when the repository exposes a check command (test,
    typecheck, lint, or build) — deterministic checks are cheaper and more reliable than manual
    inspection. Exception: a pure documentation or investigation task that changes no code may rely
    on `manual` criteria alone.
- **`blockedBy`** — array of `id` strings that must complete before this task starts.
- **`extraDimensions`** — optional kebab-case evaluator dimensions beyond the five floor dimensions
  (correctness, completeness, safety, consistency, robustness). Attach an extra dimension ONLY when
  an acceptance criterion explicitly demands a measurable property that no floor dimension covers
  AND no manual criterion already encodes it. When in doubt, omit — the floor dimensions are almost
  always sufficient. Example of a justified attachment: `migration-safety` when the task requires a
  zero-downtime schema change that the five floor dimensions cannot score on their own. Cap: 2–3 per
  task; hard max 6.
