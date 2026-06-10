# Harness Principles

Distilled from the two Anthropic harness articles and the Martin Fowler structured-prompt series. Each
principle below carries a **ralphctl status** (`applied` / `partial` / `gap`) and a **code anchor** — the
exact path where the principle is exercised today. `partial` and `gap` rows each name a concrete next step.

**When to read this doc:**

1. Before any structural change to `src/application/chain/`, `src/application/flows/<flow>/`,
   `src/application/registry.ts`, or `src/integration/ai/providers/_engine/`.
2. Before adding a new chain primitive, a new flow, or a new sub-agent.
3. On every new model release (Opus bump, Sonnet bump) — walk the `partial` and `gap` rows and ask whether
   any `applied` row has become over-built relative to the new capability baseline.

---

### 1. Multi-agent split (planner / generator / evaluator)

**Rule.** Separate the agent that writes the spec from the agent that generates code from the agent that
grades it. Mixing roles degrades all three.

**Source.** Anthropic — Harness Design: _"Multi-agent GAN structure — planner / generator / evaluator.
Evaluators tuned to skepticism; tuning standalone evaluator > making generator self-critical."_

**ralphctl status.** `applied`

**Where it lives.**

- Planner: `src/application/flows/plan/` (AI expands ticket list into `tasks.json`)
- Generator: `src/application/flows/implement/leaves/generator.ts`
- Evaluator: `src/application/flows/implement/leaves/evaluator.ts`

---

### 2. File-based agent communication

**Rule.** Agents write files; other agents read and respond. No stdout parsing for structured output — that
breaks whenever a CLI vendor changes their JSON shape.

**Source.** Anthropic — Harness Design: _"File-based agent communication. Agents write files; other agents
read and respond. Keeps work faithful to spec without over-specification."_

**ralphctl status.** `applied`

**Where it lives.**

- `signals.json` contract: the AI writes `signals.json` via its Write tool into `session.signalsFile`; the
  per-provider headless adapters (`src/integration/ai/providers/{claude,codex,copilot}/headless.ts`) thread
  that path and consume it post-spawn; per-task path computed in
  `src/application/flows/implement/leaves/round-artifacts.ts` (`roundSignalsPath`); schema/validation under
  `src/integration/ai/contract/_engine/`
- Session-id file: `src/integration/ai/providers/_engine/persist-session-id.ts`
- Per-spawn layout: `<sprintDir>/<flow>/<unit>/rounds/<N>/{generator,evaluator}/signals.json`

---

### 3. Progress file as session handoff

**Rule.** Each new context window must be able to orient itself from a file — not from memory, not from
stdout history. The progress artefact is the handoff between "shifts."

**Source.** Anthropic — Effective Harnesses: _"Agents work like software engineers collaborating across
shifts — each new engineer arrives with no memory of what happened on the previous shift."_ Progress file
= the shift handoff note.

**ralphctl status.** `applied`

**Where it lives.**

- Append-only sprint journal: `src/application/flows/implement/leaves/progress-journal.ts`
- Status-transition separator: `src/application/flows/_shared/progress/append-journal-separator.ts` (records
  `activated` / `transitioned to review` / `closed` lines between task-attempt sections)
- Prompts that consume it: `progress.md` body inlined via `{{PRIOR_PROGRESS}}` (wrapped in `<prior_progress>`)
  in `src/integration/ai/prompts/plan/template.md`, `src/integration/ai/prompts/evaluate/template.md`,
  `src/integration/ai/prompts/implement/template.md` (~line 65), `src/integration/ai/prompts/ideate/template.md`
  (~line 47), and `src/integration/ai/prompts/refine/template.md` (~line 33)

---

### 4. Git as state backbone, descriptive commits

**Rule.** Every task attempt ends in a commit. The AI agent reads `git log` at session start; commit
messages are its memory of what changed and why.

**Source.** Anthropic — Effective Harnesses: _"Git as state backbone. Descriptive commit messages enable
revert + recovery. Model reads git logs at session start."_

**ralphctl status.** `applied`

**Where it lives.**

- Commit leaf: `src/application/flows/implement/leaves/` (commit-message signal drives per-task commits)
- Conventional-commit shape: applied as a convention by the `/commit` skill (not enforced by a commitlint
  config or commit-msg hook)

---

### 5. Hard cap on attempts → blocked or done-with-warning

**Rule.** When the generator-evaluator loop exhausts its attempt budget, the task must not be silently
dropped. Silent failure hides bugs; surfacing the outcome is mandatory.

**Source.** Anthropic — Harness Design: _"Hard thresholds — any failed criterion triggers rework. Sprint
contracts define testable success up-front."_

**ralphctl status.** `applied` with deliberate deviation from the strict rule — see below.

**Where it lives.**

- `maxAttempts` setting: `src/application/chain/run/iteration-config.ts`
- Settle leaf: `src/application/flows/implement/leaves/settle-attempt.ts` (transitions to `blocked` or `done`)
- Task status enum includes `blocked` and `done`: `src/domain/entity/task.ts`
- **Outer attempt loop.** `per-task-subchain.ts` wraps the full per-attempt segment in a
  `loop('task-attempts-<id>', …, { maxIterations: task.maxAttempts, shouldStop })` so a single
  launch can run up to the effective `maxAttempts` rounds per task (`task.maxAttempts` stamped at
  plan time, with a `settings.harness.maxAttempts` fallback for legacy tasks). The graduated remedy
  ladder (row 6) fires within this outer loop — climbing one model rung per plateau or
  budget-exhausted exit, then a top-of-ladder nudge, while evaluator-malformed exits get a plain
  same-model retry — each retry consuming one attempt of the budget. `maxAttempts === 1` is
  byte-for-byte the prior one-attempt-per-launch behaviour.

**Deviation: true exhaustion → done-with-warning, not blocked.** When every remedy is exhausted (all
attempts spent, no rung remaining, or `escalateOnPlateau === false`), the task transitions to `done`
with an `AttemptWarning` rather than `blocked`. Rationale: the AI produced work on every attempt; a
`blocked` outcome would abandon it and require the operator to manually unblock. `done-with-warning`
preserves the work product and surfaces the outcome honestly (sprint journal verdict
`pass-with-warning`, the PR body's "Completed with warnings" section, the TUI tasks panel glyph) so
the operator can review and decide. The paths that DO transition to `blocked` are the own-failure
exits: a generator self-block (`<task-blocked>`), a pre-task-verify hard block, a red post-task
verify attributed to the AI's own work, and a parallel-path fold conflict — on the serial path a
blocked task's rejected diff is quarantined to a stash so siblings start clean.

---

### 6. Plateau detection (no productive iteration)

**Rule.** When consecutive evaluator rounds flag the same failed-dimension set without improvement, exit the
loop with a plateau warning rather than exhausting the full attempt budget on non-productive work.

**Source.** Anthropic — Harness Design: _"Early signs [of evaluator failure]: identifying issues then talking
self into approving anyway; superficial testing."_ Plateau detection is the harness-side guard against this.

**ralphctl status.** `applied`

**Where it lives.**

- `plateauThreshold` (2–5, patient default 3): `src/application/chain/run/iteration-config.ts`
- Exemptions (score improvement, commit progress, critique-Jaccard shift prevent counting): same file
- Loop predicate in the implement flow: `src/application/flows/implement/`
- **Graduated remedy ladder** (`src/business/task/escalation-policy.ts` + `escalation-map.ts`): on a
  plateau the policy spends remedies cheapest-first — climb the model ladder **one rung per plateau**
  (`escalate`, re-stampable, bounded by `maxAttempts`), then a single top-of-ladder same-model `nudge`
  with a change-of-approach directive, then `topped-out` (keep the work). See PERFORMANCE.md
  "Escalation on plateau".

---

### 7. Idle watchdog (kill wedged children)

**Rule.** A headless AI process whose stdout has been silent past a configurable threshold must be killed.
A stuck child cannot be allowed to strand the harness indefinitely.

**Source.** Anthropic — Effective Harnesses (implicit): robust harnesses detect and recover from wedged
sessions rather than waiting for user intervention.

**ralphctl status.** `applied`

**Where it lives.**

- `src/integration/ai/providers/_engine/idle-watchdog.ts`

---

### 8. Rate-limit retry with session resume

**Rule.** On a 429, retry with exponential backoff and pass `--resume <session-id>` so the AI continues
from where it stopped — not from scratch. Restarting wastes the prior context window.

**Source.** Anthropic — Effective Harnesses: resume via git state and session continuity. Harness Design:
_"Context resets > compaction for models with context anxiety."_

**ralphctl status.** `applied`

**Where it lives.**

- Retry loop: `src/integration/ai/providers/_engine/rate-limit-backoff.ts`
- Session-id capture: `src/integration/ai/providers/_engine/{persist-session-id,session-id}.ts`
- `--resume` pass-through: per-adapter in `src/integration/ai/providers/{claude,codex,copilot}/headless.ts`
- Cap: `settings.harness.rateLimitRetries` (0–10)

---

### 9. Sprint contracts (testable success up-front)

**Rule.** Before the AI touches a task, a verify script runs and records a baseline. After the AI commits,
the same script runs again with an attribution algorithm — the harness rejects work that regresses passing
tests, but does not block the AI for pre-existing failures.

**Source.** Anthropic — Harness Design: _"Sprint contracts define testable success up-front. Grade against
concrete criteria with hard thresholds — any failed criterion triggers rework."_

**ralphctl status.** `applied`

**Where it lives.**

- Pre-task verify + post-task verify: `src/application/flows/implement/leaves/`
- Attribution algorithm (`clean` / `regressed` / `baseline-broken` / `fixed-baseline`): implement leaves
- Scripts collected by the `detect-scripts` flow: `src/application/flows/detect-scripts/`

**Deviation — structured verify gates (WS3).** When a repo configures `Repository.verifyGates` (per-module
`{ pathPrefix, command, timeoutMs? }` gates), pre/post are deliberately ASYMMETRIC in scope: pre-verify runs
ALL gates (the baseline snapshot needs the complete picture), while post-verify runs only the gates whose
`pathPrefix` matches the attempt's diff footprint (`git diff --name-only HEAD` + untracked), fail-fast. This
is a scope optimisation — a monorepo verifyScript pays every module on every run; the gates let post-verify
pay only the modules the diff touched. Attribution stays like-vs-like and the `regressed` path is unchanged:
because post's executed set ⊆ pre's executed set (post is a diff-scoped subset of the full set pre ran), a
red scoped post on a green pre is still `regressed` per the unchanged attribution truth table. The legacy
single `verifyScript` normalises to one catch-all gate (`pathPrefix: ''`), so the non-gated path is
byte-for-byte the old behaviour. CRITICAL: a footprint probe failure or an empty footprint falls back to
running ALL gates — a gate is never silently skipped.

**Deviation — skip pre-verify on fresh setup (WS6, opt-in).** With `settings.harness.skipPreVerifyOnFreshSetup`
on (default off), the FIRST pre-task verify of a run synthesizes a green baseline (instead of re-running the
gate) when this launch's own setup script already verified that repo green and the tree is clean — the owner
asserts "my setup script verifies the tree", trading the strict pre/post symmetry for the redundant first-task
gate run. Default-off keeps the symmetry intact for everyone who has not made that assertion.

---

### 10. Native context file per provider

**Rule.** Each AI CLI discovers its context file from cwd (`CLAUDE.md`, `.github/copilot-instructions.md`,
`AGENTS.md`). The harness writes one file per distinct provider — no symlinks, no pointer schemes.

**Source.** Anthropic — Effective Harnesses: _"Cwd is the repo because Claude / Copilot / Codex only
auto-discover their context file from cwd — not from `--add-dir` roots."_

**ralphctl status.** `applied`

**Where it lives.**

- Fan-out: `src/application/flows/readiness/` fans out across every uniquely referenced provider
- One file per provider: `CLAUDE.md` / `.github/copilot-instructions.md` / `AGENTS.md`
- No symlinks by convention: `CLAUDE.md § Security & Safety`

---

### 11. Iterative review (cheap check often)

**Rule.** Run the cheapest check after each meaningful change, not at the end of the whole diff. The harness
check gate is the deployed form of this loop; the same posture belongs inside each phase's work.

**Source.** Martin Fowler — Structured Prompt Driven: iterative review concept.

**ralphctl status.** `applied`

**Where it lives.**

- Cross-phase skill: `src/integration/ai/skills/bundled/ralphctl-iterative-review/SKILL.md` (bundled skill)

---

### 12. Alignment before output

**Rule.** Name the entities, boundaries, and seams the change touches before generating code, tasks, or
acceptance criteria. "Big blob" output is a failure to align first.

**Source.** Martin Fowler — Structured Prompt Driven: alignment concept.

**ralphctl status.** `applied`

**Where it lives.**

- Cross-phase skill: `src/integration/ai/skills/bundled/ralphctl-alignment/SKILL.md` (bundled skill)

---

### 13. Abstraction-first

**Rule.** Design the shape of the change (entities, boundaries, seams) before generating code, tasks, or
acceptance criteria.

**Source.** Martin Fowler — Structured Prompt Driven: abstraction-first concept.

**ralphctl status.** `applied`

**Where it lives.**

- Cross-phase skill: `src/integration/ai/skills/bundled/ralphctl-abstraction-first/SKILL.md` (bundled skill)

---

### 14. Minimal scaffolding; remove one component at a time as models improve

**Rule.** Every harness component encodes an assumption about what the model cannot do unaided. Stress-test
that assumption on every model release. Remove non-load-bearing pieces one at a time, with measurement.

**Source.** Anthropic — Harness Design: _"Find the simplest solution possible, and only increase complexity
when needed. Every component encodes assumptions about model limitations. Stress-test assumptions; they can
go stale quickly as models improve. Remove one component at a time when simplifying. Re-examine entire
harness when new model releases; strip non-load-bearing pieces."_

**ralphctl status.** `partial`

**Where it lives.**

- Cross-phase skill: `src/integration/ai/skills/bundled/ralphctl-minimal-scaffolding/SKILL.md` (bundled skill)
- No audit cadence yet — nothing enforces a per-model-release walk of this doc.

**Note — parallelism as above-the-chain orchestration.** The `maxParallelTasks > 1` parallel
execution was deliberately implemented as `runWaves` — an async orchestrator that sits
**above** the five chain primitives, not as a sixth primitive (`forEachItem` / `parallel`). The
five-primitive rule (`element` / `leaf` / `sequential` / `loop` / `guard`) is unchanged.
`runWaves` never implements `Element` and must never be composed into a `sequential`/`loop`/`guard`.

**Next step.** The `ralphctl-minimal-scaffolding` skill captures the principle; what's missing is a ritual.
Add a checklist block to the "How to use this doc" section (below) and gate it on a team process (e.g.
open a ticket when a new model version ships).

---

### 15. Evaluator over-praises by default; needs heavy tuning

**Rule.** An LLM evaluator out-of-the-box is a poor QA agent — it will identify issues and then talk itself
into approving anyway. The evaluate prompt must name concrete failure modes, weight subjective criteria
heavier than technical defaults, and use few-shot calibration toward harsh grading.

**Source.** Anthropic — Harness Design: _"LLMs are poor QA agents out-of-box. Early signs: identifying
issues then talking self into approving anyway; superficial testing. Fix: read logs, identify judgment
divergence from desired outcomes, update prompts iteratively. Requires significant prompt tuning to avoid
over-praising."_

**ralphctl status.** `applied`

**Where it lives.**

- Evaluator template: `src/integration/ai/prompts/evaluate/template.md`
- Today's template grades against `{{VERIFICATION_CRITERIA_SECTION}}` and the verify-script outcome, opens
  with "Skepticism is your default", pins a four-dimension floor rubric (correctness / completeness / safety
  / consistency — any FAIL forces `status: "failed"`), and carries an explicit "Evaluator failure modes to
  resist actively" block naming talking-self-into-approval, superficial testing, crediting incomplete work,
  and rubber-stamping on a green verify script. Status moved `gap` → `applied`.

---

### 16. Context reset vs compaction for long sessions

**Rule.** Decide explicitly — before a session starts — whether the AI should assume a fresh context window
or continue from a prior one. Ambiguity here causes the AI to behave as though it has context it doesn't, or
to compact unnecessarily.

**Source.** Anthropic — Harness Design: _"Resets > compaction for models with context anxiety. Opus 4.5 had
strong context anxiety; Opus 4.6 largely eliminated it. Automatic compaction can handle context growth in
continuous sessions with capable models."_

**ralphctl status.** `applied`

**Where it lives.**

- Session scoping: `src/application/session/session.ts` (`AsyncLocalStorage` per runner call)
- Interactive flows (refine / plan / ideate) hand off a full session to the AI CLI; the AI decides how to
  handle its own context.
- Prompt templates now state the convention explicitly: `plan` / `ideate` open with "No prior context is
  assumed — … fresh", and `refine` with "No prior context from any earlier session is assumed; read
  `<prior_progress>` below to orient yourself on this sprint".

---

### 17. Cost-benefit framing (evaluator value tied to task difficulty / model capability)

**Rule.** The evaluator adds cost and latency. Its value depends on task difficulty relative to model
capability — and that relationship shifts as models improve. Design flow surfaces so the lighter `ideate`
path is the default for low-stakes work; full `implement` (with evaluator) is reserved for tasks where
the evaluator pays for itself.

**Source.** Anthropic — Harness Design: _"Solo agent (20 min, $9) vs full harness (6 hr, $200) — 20x
expense for substantially better output. Evaluator value depends on task difficulty relative to model
capability. Boundary shifts as models improve."_ Also: _"The space of interesting harness combinations
doesn't shrink as models improve. Instead, it moves."_

**ralphctl status.** `gap`

**Where it lives.**

- `ideate`: `src/application/flows/ideate/` — single AI session, no evaluator loop
- `implement`: `src/application/flows/implement/` — full generator-evaluator-settle loop
- No guidance in the TUI help text or the designer agent steers the flow-surface choice toward cost-benefit
  thinking.

**Next step.** The `designer` agent owns the flow surface. When designing a new flow's TUI/CLI entry point,
reference this section to weigh `ideate` (single session, low ceremony, lower cost) vs full `implement`
(evaluator loop, higher confidence, higher cost). Add this framing to the designer agent's Design Principles
and to flow help text for new flows.

---

### 18. Every harness component encodes assumptions about model limits; re-audit on model bumps

**Rule.** When a new model version ships, walk every `partial` and `gap` row in this doc and re-evaluate
every `applied` row's load-bearing status. Components that were necessary for Opus 4.5 may be overhead for
Opus 4.7.

**Source.** Anthropic — Harness Design: _"Re-examine entire harness when new model releases; strip
non-load-bearing pieces."_

**ralphctl status.** `gap`

**Where it lives.**

- No audit cadence exists. This doc is the intended home for the checklist; the `ralphctl-minimal-scaffolding`
  skill captures the per-change discipline.

**Next step.** On every significant model release (Opus bump, Sonnet bump), open a ticket: "Model-bump
harness audit." The ritual: read this doc top-to-bottom; for each `applied` row, ask "is this still
load-bearing against the new model?" For `partial` / `gap` rows, ask "has the model closed the gap
unaided?" Findings feed into targeted removals or promos from `gap` → `applied`.

---

## How to use this doc

**Before structural changes.** Read before adding a chain primitive, a new flow, a new sub-agent, or any
change to `src/integration/ai/providers/_engine/`. The relevant principle section names the risk; the status
tag says how covered ralphctl is today.

**Before model-bump work.** Read the full principle list. Walk `partial` and `gap` rows first — a model
upgrade may close gaps for free. Then walk `applied` rows and ask whether any have become over-built.

**When a `gap` closes.** Update the row's status from `gap` → `applied` (or `partial` → `applied`),
update the "Where it lives" anchor, and remove the "Next step" line. Cross-reference the commit that closed
it.
