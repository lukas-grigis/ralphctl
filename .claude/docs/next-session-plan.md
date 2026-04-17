# Next session plan — Opus 4.7 prompt adaptation + evaluator gap

> Read this end-to-end before coding. The previous session (2026-04-16) finished
> the pipeline-map arc (Commits A–H), restored the task-execution prompt flow,
> and deleted a round of dead code. This document is the plan for what's next.

## Source-of-truth references — re-fetch when in doubt

- **Opus 4.7 announcement** (model behaviour changes + new features): https://www.anthropic.com/news/claude-opus-4-7
- **Best practices for Claude Opus 4.7 with Claude Code** (concrete prompt/harness guidance): https://claude.com/blog/best-practices-for-using-claude-opus-4-7-with-claude-code

Both URLs were fetched 2026-04-16. If the landscape shifts, fetch again — don't rely on this doc's paraphrase.

## Key Opus 4.7 facts driving this plan

| Fact                                                                                                                                                   | Implication                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Literal instruction following** — "prompts written for earlier models can sometimes now produce unexpected results"                                  | Every `.md` template needs an audit for contradictions, dangling imperatives, implicit assumptions.                                |
| **Tokenizer inflation 1.0–1.35×** for the same input                                                                                                   | Long prompts (task-execution.md in particular) may now overflow prior budgets — trim redundant sections.                           |
| **Positive examples > negative constraints** — "use positive examples of desired voice/style rather than 'don't do this'"                              | Convert "don't X" to "do Y" where accurate. Keep hard negatives for genuine safety.                                                |
| **Upfront task specification** — "specify the task up front, in the first turn"                                                                        | Our per-task context file already does this well. Verify each template's first-screen block is self-sufficient.                    |
| **New `xhigh` effort level** (between `high` and `max`); Claude Code defaults to `xhigh` for plans                                                     | If the CLI exposes `--effort`, our Claude provider should default to `xhigh` (Arc 2a).                                             |
| **Subagent delegation guidance** — "do not spawn a subagent for work you can complete directly; spawn multiple subagents in one turn when fanning out" | Our `.claude/agents/` has designer/tester/implementer/reviewer/auditor/planner. Task-execution prompt should say WHEN to delegate. |
| **Thinking directives** work: "think carefully and step-by-step" / "prioritize responding quickly"                                                     | Apply per-template where the task shape warrants it (evaluator benefits; trivial tasks don't).                                     |
| **Model ID:** `claude-opus-4-7`                                                                                                                        | Add to the evaluator's model-ladder string match.                                                                                  |

## Project state when this plan was written

- Branch `feature/misc`, **18 commits ahead of `main`**, version `0.2.5`.
- `pnpm typecheck && pnpm lint && pnpm test` green — **1340 tests**.
- Pipeline-map arc (Commits A–H) done.
- Task-execution prompt flow restored: `executeOneTask` builds rich context, writes per-task context file, spawns with "Read file and follow instructions".
- Dead code sweep round 1 done: `permissions.ts` deleted, `task-context.ts` trimmed to just `getRecentGitHistory`.
- Known gaps left on purpose: `ExecutePhaseView` auto-starts execution on drill-in (UX decision pending); permission-mode warnings not surfaced; evaluator still has a separate prompt gap (Arc 1a below).

## Files you'll touch most

- `src/integration/ai/prompts/*.md` — every template gets audited.
- `src/integration/ai/prompts/loader.ts` — if a new placeholder is added.
- `src/integration/ai/prompt-builder-adapter.ts` — for Arc 1a.
- `src/business/ports/prompt-builder.ts` — port signature for Arc 1a.
- `src/business/usecases/evaluate.ts` — Arc 1a context building + Arc 1c model ladder.
- `src/integration/ai/providers/claude.ts` — Arc 2a effort flag.

## Non-negotiables (inherited from prior handoff)

- `pnpm typecheck && pnpm lint && pnpm test` green at every commit boundary.
- No barrel files under `src/`.
- No use-case → CLI imports (ESLint fence holds).
- No business → integration imports in production.
- One logical change per commit.
- Never `--no-verify` or `--amend` published commits.

---

## Arc 1 — Prompt integrity

### 1a. Evaluator prompt gap (small, do first as warmup)

The adapter's `buildTaskEvaluationPrompt` hardcodes `checkScriptSection: null` and `projectToolingSection: ''` — so the evaluator never sees the resolved check script or the Project Tooling section (subagents, MCPs, skills). Same class of bug as the execution-prompt issue we fixed.

**File-level changes:**

- `src/business/ports/prompt-builder.ts` — change signature from `(task, sprint, context)` to `(task, sprint, checkScriptSection, projectToolingSection)`. Drop the unused `context` param (same cleanup pattern as execution).
- `src/integration/ai/prompt-builder-adapter.ts` — thin bridge: forward the two args directly into `buildEvaluatorPrompt`. No more hardcoded nulls.
- `src/business/usecases/evaluate.ts`:
  - Resolve `checkScript` for `task.projectPath` via the shared `findProjectForPath` + `resolveCheckScript` helpers at `src/business/pipelines/steps/project-lookup.ts`.
  - Resolve project tooling via `external.detectProjectTooling([task.projectPath])` — port already exposes this, planners use it.
  - Build the two string arguments and pass into the prompt builder.
- Regression guard: add a case to `src/integration/ai/prompt-builder-adapter.test.ts` asserting the rendered prompt contains the check-script text when supplied (and doesn't contain a literal `null`).

**Commit:** `fix(evaluate): thread check script + project tooling into evaluator prompt`

### 1b. Opus 4.7 prompt audit (the main work)

**Audit dimensions — apply all of these to every template:**

| #   | Dimension                  | Check                                                                                                                                                                     |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Contradictions             | Two rules conflict — 4.7 picks one literally. Fix or order explicitly.                                                                                                    |
| 2   | Dangling imperatives       | "consider X" / "if relevant" / "when appropriate" — over- or under-applied. Make conditional or remove.                                                                   |
| 3   | Implicit assumptions       | Things 4.6 inferred but 4.7 needs explicit — name them.                                                                                                                   |
| 4   | Negative → positive        | "don't X" → "do Y". Keep hard safety negatives (don't-commit-this-file).                                                                                                  |
| 5   | Upfront specification      | First-screen block self-sufficient for task intent + constraints + acceptance criteria.                                                                                   |
| 6   | Length/format expectations | State explicitly where format is load-bearing (progress.md entry, `<task-verified>` block).                                                                               |
| 7   | Subagent delegation        | Mention WHEN to delegate to subagents (see `.claude/agents/*.md`). Execution prompt = specialized work (designer/auditor/tester). Evaluator = auditor for security diffs. |
| 8   | Thinking directives        | "Think carefully and step-by-step" for critique/design work. Omit for trivial tasks.                                                                                      |
| 9   | Token budget               | 1.0–1.35× inflation — trim redundant sections in long templates.                                                                                                          |

**Templates to audit — one commit per template (or partial group):**

1. `src/integration/ai/prompts/task-execution.md` — generator, highest impact
2. `src/integration/ai/prompts/task-evaluation.md` — evaluator
3. `src/integration/ai/prompts/task-evaluation-resume.md` — resume critique
4. Partials group: `harness-context.md`, `signals-task.md`, `signals-evaluation.md`, `signals-planning.md`, `validation-checklist.md`, `plan-common.md`
5. `plan-auto.md` + `plan-interactive.md`
6. `ideate.md` + `ideate-auto.md`
7. `ticket-refine.md`
8. `sprint-feedback.md`

**Per-commit workflow:**

1. Read the template.
2. Score it against dimensions 1–9; list specific problem snippets.
3. Write the edit.
4. Render via the builder function with fixture inputs — actually eyeball the output.
5. Run `pnpm test` (loader tests catch placeholder regressions).
6. Commit with a message naming the specific 4.7-related issues addressed.

**Non-goals:**

- No per-model prompt variants.
- No structural changes to how partials compose.
- No new signal types.
- No rewrites that change intent — this is clarifying, not redesigning.

**Expected commit messages** (examples, not verbatim):

- `fix(prompts): tighten task-execution for opus-4.7 literal interpretation`
- `fix(prompts): add subagent delegation guidance to task-execution`
- `fix(prompts): convert negative constraints to positive examples in task-evaluation`
- `fix(prompts): trim redundant sections in harness-context partial`

### 1c. Model ladder + ID recognition

- `src/business/usecases/evaluate.ts` `getEvaluatorModel(generatorModel, provider)` (around line 32–39) — add string match for `opus-4-7` → `claude-sonnet-4-6`. Sonnet is the next-strongest general model; matches the Opus → Sonnet → Haiku ladder pattern.
- Update the docstring comment to mention 4.7.

**Commit:** `feat(evaluate): add claude-opus-4-7 to evaluator model-ladder`

---

## Arc 2 — Model feature support

### 2a. Claude `--effort` flag (only if CLI supports it)

4.7 introduces `xhigh` effort; Claude Code CLI defaults to `xhigh` for plans.

**Steps:**

1. Run `claude --help` (if available in PATH) — check for `--effort` flag.
2. If present: add `'--effort', 'xhigh'` to `baseArgs` in `src/integration/ai/providers/claude.ts`. Document the change in the provider file's header comment.
3. If absent: write a short note in CLAUDE.md under "Provider Differences" and skip this sub-arc.

**Non-goals:** no per-task effort tuning; no effort-level config in `settings.json`; no plumbing through `ExecutionOptions`.

**Commit (if applicable):** `feat(claude): default to --effort xhigh for opus-4.7`

### 2b. Task Budgets (defer)

Public-beta feature on the Claude Platform API, not CLI. Skip.

---

## Arc 3 — Rolling quality improvement (overlay on every commit)

**Definition of done, applied to EVERY commit:**

1. `pnpm typecheck && pnpm lint && pnpm test` green.
2. In the files touched:
   - `grep` for unused exports; delete or mark TODO.
   - `grep` for `TODO` / `FIXME` / `XXX` adjacent to changes; resolve if cheap.
3. If a touched file is >300 LOC, note whether it splits cleanly; do the split only when the seam is obvious.
4. No new barrel files. No layering violations. No `--no-verify`.
5. Commit message calls out any simplification deferred so the next Claude picks it up.

**Candidate sweep areas (not mandatory — opportunistic):**

- `src/integration/ai/` — post permissions-deletion, run `pnpm dlx knip` for residual orphans.
- `src/integration/ui/tui/views/phases/` — three phase views share a load-sprint pattern; don't extract unless a 4th view lands.
- `src/business/pipelines/execute/` — deliberately complex per earlier handoff; leave alone.

---

## Execution order

1. **Arc 1a** (evaluator gap) — small, focused, good warmup. ~30 lines changed.
2. **Arc 1c** (model ladder) — one-line feature add; lands second.
3. **Arc 1b** (prompt audit) — main work. One commit per template. Expect 8–12 commits here.
4. **Arc 2a** (effort flag) — gated on Claude CLI support; otherwise skip + document.

---

## Deferred / explicit non-goals

- `ExecutePhaseView` auto-start on drill-in — UX decision pending.
- Permission-mode warnings — restore if users report missing them.
- Release prep / version bump — the user said "do not yet prepare for release".
- Making `claude-opus-4-7` the _default_ provider model — keep `aiProvider` config as-is; user selects model via their Claude Code settings.
- Per-template model variants.
- Task Budgets (beta API feature).
- `forEachTask` / `PerTaskPipeline` simplification — still requires a second consumer.
- Phase-view hook extraction — premature abstraction.

---

## First message for the new session

> Read `.claude/docs/next-session-plan.md` end-to-end before responding. Then execute arc by arc, one commit at a time, starting with Arc 1a (evaluator gap). Before editing any prompt template in Arc 1b, render the prompt via its builder with fixture inputs and paste the diff so I can sanity-check. Ask before each commit. Every commit must satisfy Arc 3's definition-of-done. If Opus 4.7 guidance has changed since this doc was written (2026-04-16), re-fetch the two URLs in the References section first.
