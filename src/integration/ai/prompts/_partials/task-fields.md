Each task entry uses these fields:

- **`id`** — short, stable string used only for `blockedBy` references within this array (e.g.
  `"1"`, `"T1"`, `"api-shape"`).
- **`name`** — imperative verb phrase, short (e.g. `"Wire CSV export endpoint"`).
- **`description`** — one or two sentences on the problem this task solves and why; skip it only when
  `name` already says both.
- **`projectPath`** — absolute path matching exactly one of the repositories listed under
  `<repositories>`.
- **`steps`** — concrete, ordered implementation steps. Don't end steps with "run the
  verification commands" or "run all the checks" — verification belongs in `verificationCriteria`;
  the harness and the evaluator execute it. A final step that re-runs the full suite only
  duplicates the post-task gate and inflates generator cost. Exception: a step may run a specific
  check when a later step depends on its output (e.g. "run the migration dry-run and confirm the
  schema diff before writing the rollback script").
- **`verificationCriteria`** — array of structured criteria the evaluator grades PASS / FAIL:
  - `id` — stable within the task (e.g. `"C1"`); the evaluator cites it verbatim.
  - `assertion` — human-readable check.
  - `check` — `"auto"` (evaluator runs `command`) or `"manual"` (evaluator inspects code or
    behaviour and cites a specific location).
  - `command` — required when `check === "auto"`; omit it when `check === "manual"`. Use
    the project's own commands — never hardcode a package-manager binary; read the project's
    manifest or context file for the actual command.
  - Scope a test command to the tests this task adds or changes (file path, test-name filter, or
    tag); typecheck, lint, and build commands may run project-wide unless that exact command is a
    verify gate. Never repeat a verify gate, whatever it runs, and never put a whole end-to-end or
    browser suite in an `auto` criterion — scope it to the spec files this task adds or changes. Exception: when that runner still needs something the evaluator's
    shell cannot provide (a server it does not start itself, a seeded database, credentials), check
    that behaviour with a `manual` criterion instead.
  - When the repository lists a verify gate under `<repositories>` that has no path note and whose
    command runs the test suite (read the script it calls when it names one), never run a whole test
    suite of any kind — unit, integration, or end-to-end. The harness runs that gate after every
    task, and one unrelated failing test would make the criterion impossible to pass without editing
    tests the task does not own. Otherwise — no verify gate, a gate that runs no tests, or only gates
    with a path note — nothing guarantees a project-wide test run after the task, so add one
    criterion running the suite CI gates on (the subset CI selects, when it selects one), leaving out
    any suite the previous rule excludes.
  - Exception to both rules above: a task whose stated purpose is to make a suite pass may name that
    suite.
  - Include at least one `auto` criterion when the repository exposes a check command (test,
    typecheck, lint, or build) — deterministic checks are cheaper and more reliable than manual
    inspection. Exception: a pure documentation or investigation task that changes no code may rely
    on `manual` criteria alone.
- **`blockedBy`** — array of `id` strings that must complete before this task starts.
- **`extraDimensions`** — optional kebab-case evaluator dimensions beyond the five floor dimensions
  (correctness, completeness, safety, consistency, robustness). Attach an extra dimension only when
  an acceptance criterion explicitly demands a measurable property that no floor dimension covers
  and no manual criterion already encodes it. When in doubt, omit — the floor dimensions are almost
  always sufficient. Example of a justified attachment: `migration-safety` when the task requires a
  zero-downtime schema change that the five floor dimensions cannot score on their own. Cap: 2–3 per
  task; hard max 6.
