# Prompt Template Audit — Issue #75

Per-file audit of `src/integration/ai/prompts/*.md`. Prompts run in **downstream projects** (Node, Python, Go, Rust,
Java, mixed), so they must be ecosystem-generic and free of ralphctl-specific leakage.

**Columns:**

- **Role** — clear one-line role + mission statement
- **XML** — structural inputs sit inside XML tags (`<context>`, `<requirements>`, `<constraints>`, `<examples>`, …)
- **Output** — output contract precise (either `{{SIGNALS}}` or a schema + example)
- **Placeholder-safe** — conditional placeholders expand cleanly when empty (no orphan numbering, no double blanks)
- **No ralphctl leak** — template does not name ralphctl, its repo layout, or its own subagents
- **Ecosystem-generic** — no hardcoded `pnpm` / `npm` / `pip` / `cargo` outside `{{PROJECT_TOOLING}}` / `{{CHECK_GATE_EXAMPLE}}`
- **Em-dash** — explanatory clauses use `—`, not `-`
- **Absolute-rule-free** — "never" rules name their legitimate exception

## Checkbox table

| File                        | Role | XML | Output | Placeholder-safe | No ralphctl leak | Ecosystem-generic | Em-dash | Absolute-rule-free | Notes                                                                                                                 |
| --------------------------- | :--: | :-: | :----: | :--------------: | :--------------: | :---------------: | :-----: | :----------------: | --------------------------------------------------------------------------------------------------------------------- |
| `harness-context.md`        |  ✓   |  ✓  |  n/a   |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | Single `<harness-context>` block, 3 lines.                                                                            |
| `validation-checklist.md`   |  ✓   |  ✓  |  n/a   |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | Wrapped in `<validation-checklist>`.                                                                                  |
| `signals-task.md`           | n/a  |  ✓  |   ✓    |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | `<signals>` contract block.                                                                                           |
| `signals-planning.md`       | n/a  |  ✓  |   ✓    |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | `<signals>` contract block.                                                                                           |
| `signals-evaluation.md`     | n/a  |  ✓  |   ✓    |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | `<signals>` contract block.                                                                                           |
| `plan-common.md`            | n/a  |  ✓  |  n/a   |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | Shared planner partial; inlined inside callers' outer `<context>` block.                                              |
| `plan-auto.md`              |  ✓   |  ✓  |   ✓    |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | Sprint context wrapped in `<context>`.                                                                                |
| `plan-interactive.md`       |  ✓   |  ✓  |   ✓    |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | Sprint context wrapped in `<context>`; inline gate prose generalised.                                                 |
| `ideate.md`                 |  ✓   |  ✓  |   ✓    |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | Idea + repositories wrapped in `<context>`.                                                                           |
| `ideate-auto.md`            |  ✓   |  ✓  |   ✓    |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | Idea + repositories wrapped in `<context>`.                                                                           |
| `ticket-refine.md`          |  ✓   |  ✓  |   ✓    |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | `{{TICKET}}` wrapped in `<task-specification>`; `{{ISSUE_CONTEXT}}` wrapped in `<context>`.                           |
| `task-execution.md`         |  ✓   |  ✓  |   ✓    |        ✓         |        ✓         |        ✓\*        |    ✓    |         ✓          | Check-gate example via `{{CHECK_GATE_EXAMPLE}}`; `{{COMMIT_STEP}}` owns its own line (no indent artefact when empty). |
| `task-evaluation.md`        |  ✓   |  ✓  |   ✓    |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | `<dimension name="…" floor="…">` blocks; `<examples>` around discovery file list + calibration.                       |
| `task-evaluation-resume.md` |  ✓   |  ✓  |   ✓    |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | Critique is the single input.                                                                                         |
| `sprint-feedback.md`        |  ✓   |  ✓  |   ✓    |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | Human feedback wrapped in `<task-specification>` (canonical).                                                         |
| `repo-onboard.md`           |  ✓   |  ✓  |   ✓    |        ✓         |        ✓         |         ✓         |    ✓    |         ✓          | Setup-time prompt for `project onboard`; emits `<agents-md>` + `<check-script>` + `<changes>` (update mode).          |

\*Pending smoke run — see Verification Log.

## Canonical XML vocabulary

Every structural input sits inside one of these tags. Adding a new tag requires a row below (and a docs update).

| Tag                                          | Semantics                                                                                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<harness-context>`                          | Harness lifecycle hints (context compaction, session management).                                                                                                                                                       |
| `<task-specification>`                       | The immutable contract under action — task name, steps, criteria. Do not paraphrase or weaken.                                                                                                                          |
| `<context>`                                  | Environmental state — sprint, repositories, prior progress, project config pointers.                                                                                                                                    |
| `<requirements>`                             | Approved ticket requirements — implementation-agnostic WHAT.                                                                                                                                                            |
| `<constraints>`                              | Do/don't rules with named exceptions.                                                                                                                                                                                   |
| `<examples>`                                 | Non-normative illustrations. Treat as examples, not mandates.                                                                                                                                                           |
| `<dimension name="..." floor="true\|false">` | Evaluator rubric unit. `floor="true"` means grade every task; `floor="false"` means planner-emitted per-task extra.                                                                                                     |
| `<signals>`                                  | Output signal contract — the exhaustive list of structural tags the role may emit.                                                                                                                                      |
| `<validation-checklist>`                     | Pre-output self-check list (only in `validation-checklist.md`).                                                                                                                                                         |
| `<agents-md>`                                | Proposed project context file body (legacy `<agents-md>` tag name preserved as stable wire contract) emitted by the onboard AI session; consumed inline by the onboard pipeline. No durable handler, no sprint context. |
| `<changes>`                                  | Emitted in `update` mode only; bullet list summarising the diff between the prior project context file and the new proposal (additions / removals / rewrites with one-line rationale). No durable handler.              |

## Anti-patterns locked in CI

Enforced by `loader.test.ts` under the `prompt template generic-content audits` describe block:

- No `ralphctl` string anywhere in any `.md` template.
- No backtick-wrapped hardcoded subagent names (`` `auditor` ``, `` `reviewer` ``, …) — subagent catalogs come from
  runtime detection, not prompt content.
- No literal package-manager commands (`pnpm`, `npm`, `pip`, `cargo`, `go test`) in planner/execution/evaluator
  renderings — they must flow through `{{PROJECT_TOOLING}}` or `{{CHECK_GATE_EXAMPLE}}`.
- Every top-level input block in planner-role prompts sits inside a known XML tag from the vocabulary above.
- Every conditional placeholder expands cleanly when empty (builds with `noCommit=true` and `extraDimensions=[]` leave
  no orphan numbering or double blank lines).

## Verification Log

Last updated: 2026-04-20.

**Structurally verified in CI:**

- Byte-identical rendering across callers — `loader.ts` returns a plain `string` and has no branching on the calling
  surface (Ink TUI vs plain-text CLI vs tests). The same inputs produce the same output everywhere.
- Three anti-pattern guards in `loader.test.ts` — no `ralphctl` string, no hardcoded subagent names, no literal
  package-manager commands in rendered planner / execution / evaluator prompts.
- Structural XML wrapping — every planner-role rendered prompt matches the known-tag allowlist.
- Placeholder hygiene — empty conditionals (`noCommit=true`, `extraDimensions=[]`) leave no orphan numbering, no
  indented-only lines, no double-blank runs.
- TUI-parity fixture — `prompt rendering is surface-agnostic (TUI parity)` asserts deterministic output and the
  absence of ANSI escapes / Ink component tags across every builder.

**Pending (recommended before tagging a release):**

- **Manual smoke run across one Node + one Python repo.** Procedure: run `ralphctl sprint plan` on each; confirm
  generated `tasks.json` does not embed Node-isms (`pnpm`, `npm run`, `package.json` scripts) inside tasks that
  execute against a Python repo. The CI regex check catches package-manager commands in the _templates_; only a
  live run against a real heterogeneous project catches leakage via `{{PROJECT_TOOLING}}` or `{{CONTEXT}}`. Log
  results here when performed.

## Follow-ups

Separate tickets — tracked here so #75 can close cleanly.

- **Dynamic `CHECK_GATE_EXAMPLE`.** The neutral example is substituted everywhere, including runtime task execution
  where the real `Repository.checkScript` is already known. Consider splitting into a generic
  `PLANNER_CHECK_GATE_EXAMPLE` (stays neutral for the planner) and a runtime-aware renderer that uses
  `Repository.checkScript` when configured for `buildTaskExecutionPrompt`.
- **`<thinking>` scratchpad for `task-evaluation.md`.** The evaluator is autonomous and performs multi-dimensional
  grading — a structured scratchpad (the same pattern used in headless planners) could lift grading quality. Not
  wired today.

## Re-run before every release

Run `pnpm test` — the audit suite (in `loader.test.ts`) must stay green. Visually re-check the table above when a
template is added or when the canonical vocabulary grows.
