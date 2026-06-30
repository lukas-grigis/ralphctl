---
name: harness-engineering
description: 'Article-grounded reference for the three Anthropic harness articles. Use when designing or auditing an agent harness, reasoning about long-running-agent state / memory / progress handoff, deciding how much scaffolding a flow needs, pruning components on a model bump, or designing a generator / evaluator split. The fuller "why" behind the `harness-principles` trigger and `.claude/docs/HARNESS-PRINCIPLES.md` status map.'
when_to_use: 'When the work needs the reasoning behind a harness decision rather than the ralphctl status: simplicity-ladder / workflow-vs-agent vocabulary, the long-running amnesia problem and externalized-state remedy, the two-phase (initializer / per-session) prompt, clean-state handoff and end-to-end self-verification, the generator / evaluator (GAN) split and gradable quality, context reset vs compaction, or the meta-rule that every component encodes a model-capability assumption to stress-test on each model bump. Pairs with: read `harness-principles` for the read-first gate and `HARNESS-PRINCIPLES.md` for applied/partial/gap status; read THIS for the source reasoning and verbatim quotes.'
---

# Harness Engineering — article-grounded reference

A themed synthesis of three Anthropic engineering articles on building harnesses for agentic and
long-running coding work. This is the **reference / the why**. Two siblings carry the other halves:

- `harness-principles` (skill) — the lightweight **read-first trigger** for structural changes.
- `.claude/docs/HARNESS-PRINCIPLES.md` — the **ralphctl status map** (each principle tagged
  `applied` / `partial` / `gap` with a code anchor).

This skill does not restate those. It distills the source articles by **theme**, keeps the load-bearing
verbatim quotes with attribution, and ends with a brief pointer to where each idea lives in ralphctl.
Citation labels below map to the **Sources** section. Open the original when a rationale needs full framing.

---

## 1. Climb the complexity ladder reluctantly (workflow vs agent)

The vocabulary first. **Workflows** are _"systems where LLMs and tools are orchestrated through predefined
code paths"_; **agents** are _"systems where LLMs dynamically direct their own processes and tool usage,
maintaining control over how they accomplish tasks"_ (Building Effective Agents). Most production work
wants the predictability of a workflow, not the open-endedness of an agent.

The ladder ascends from a **direct API call** → the **augmented LLM** (retrieval / tools / memory) → a
single **workflow pattern** → **composed workflows** → an **autonomous agent**. Five workflow patterns are
named: prompt chaining, routing, parallelization (sectioning + voting), orchestrator-workers, and
evaluator-optimizer. You climb a rung only when the lower one demonstrably fails.

> "Consistently, the most successful implementations weren't using complex frameworks or specialized
> libraries. Instead, they were building with simple, composable patterns." — Building Effective Agents

> "You should consider adding complexity _only_ when it demonstrably improves outcomes." — Building Effective Agents

Corollary: invest in the **agent-computer interface (ACI)** as much as a human UI — tool docs, examples,
and poka-yoke (e.g. absolute over relative filepaths) earn their keep. Frameworks _"often create extra
layers of abstraction that can obscure the underlying prompts and responses, making them harder to debug."_

## 2. The amnesia problem and externalized state

> "The core challenge of long-running agents is that they must work in discrete sessions, and each new
> session begins with no memory of what came before." — Effective Harnesses

The governing metaphor: _"a software project staffed by engineers working in shifts, where each new
engineer arrives with no memory of what happened on the previous shift."_ The off-the-shelf runtime is not
enough on its own — and the load-bearing caveat:

> "However, compaction isn't sufficient. Out of the box, even a frontier coding model … running on the
> Claude Agent SDK in a loop across multiple context windows will fall short … if it's only given a
> high-level prompt." — Effective Harnesses

The remedy is **externalized, structured state on disk**, read fresh each session:

- a **progress log** (`claude-progress.txt`) — a human-readable running summary, written at session end and
  read back at the next session start;
- the **git history** — descriptive commits as the per-change audit + recovery trail;
- a **JSON spec/feature backlog** — each item with `category`, `description`, ordered `steps`, and a
  boolean `passes` flag flipped only after verification. JSON deliberately, _"as the model is less likely
  to inappropriately change or overwrite JSON files compared to Markdown files."_ Status is the count of
  passing items, not the model's vibe. Descriptions are protected: _"It is unacceptable to remove or edit
  tests because this could lead to missing or buggy functionality."_

> "The key insight here was finding a way for agents to quickly understand the state of work when starting
> with a fresh context window … the claude-progress.txt file alongside the git history." — Effective Harnesses

## 3. The two-phase prompt (initializer vs per-session)

Two **prompts**, one harness (same system prompt / tools). An **initializer** runs only for the first
context window: it writes an `init.sh` (boot the dev server + run a basic end-to-end smoke test), the
progress file, the comprehensive feature list, and an initial git commit — _"the foundation for all the
features that a given prompt requires."_ A **coding agent** runs every subsequent session and makes
**incremental progress**, re-orienting from the artifacts:

1. `pwd` (confirm the sandbox boundary).
2. Read the progress file + `git log --oneline -20`.
3. Read the feature list; pick the highest-priority not-yet-passing item.
4. Run `init.sh` to smoke-test that the app still works end-to-end — fix any breakage **before** new work.

This mirrors ordinary good engineering shift-handoff hygiene: _"Inspiration for these practices came from
knowing what effective software engineers do every day."_ (Effective Harnesses)

## 4. Clean-state handoff and end-to-end self-verification

Two dominant failure modes, two guards. **Over-ambition / one-shotting** is countered by working **one
feature at a time** — _"This incremental approach turned out to be critical to addressing the agent's
tendency to do too much at once."_ **Premature "I'm done"** is countered by verifying every feature
**end-to-end as a real user** (e.g. browser automation): _"the agent was able to identify and fix bugs that
weren't obvious from the code alone."_ Each session must close in a mergeable state:

> "By 'clean state' we mean the kind of code that would be appropriate for merging to a main branch: there
> are no major bugs, the code is orderly and well-documented, and … a developer could easily begin work on
> a new feature without first having to clean up an unrelated mess." — Effective Harnesses

Git is the recovery substrate — descriptive commits let the model _"use git to revert bad code changes and
recover working states of the code base"_ and remove the need to guess at what an earlier shift did.

## 5. The generator / evaluator (GAN) split and gradable quality

Separate the agent doing the work from the agent judging it — inspired by GANs (Harness Design). The
failure it solves: _"When asked to evaluate work they've produced, agents tend to respond by confidently
praising the work — even when … the quality is obviously mediocre."_ The lever:

> "Tuning a standalone evaluator to be skeptical turns out to be far more tractable than making a generator
> critical of its own work, and once that external feedback exists, the generator has something concrete to
> iterate against." — Harness Design

Make subjective quality **gradable** — turn _"Is this design beautiful?"_ into _"does this follow our
principles for good design?"_ Give the **same named criteria with hard thresholds** to both generator and
evaluator; **weight toward the model's weak axes** (not where it already scores well); **calibrate the
evaluator with few-shot examples + score breakdowns** to cut drift; and let the evaluator **use the live
product** (Playwright/Puppeteer MCP), not a static screenshot. Note that criterion **wording itself steers
output** ("museum quality" pushed visual convergence before any feedback).

For full-stack builds this becomes a **three-agent** architecture — **planner** (expands a 1–4 sentence
prompt into an ambitious, deliberately high-level spec; granular wrong details cascade downstream),
**generator**, **evaluator** — joined by a **sprint contract**: _"Before each sprint, the generator and
evaluator negotiated … what 'done' looked like … before any code was written."_ Communication is
file-based: _"one agent would write a file, another agent would read it and respond."_

## 6. Context reset vs compaction ("context anxiety")

> "Context resets — clearing the context window entirely and starting a fresh agent, combined with a
> structured handoff that carries the previous agent's state and the next steps — addresses both these
> issues." — Harness Design

Contrast with compaction (summarize-in-place): _"While compaction preserves continuity, it doesn't give the
agent a clean slate, which means context anxiety can still persist. A reset provides a clean slate, at the
cost of the handoff artifact having enough state for the next agent to pick up the work cleanly."_

The choice is **model-dependent**. _"Context anxiety"_ = models _"wrapping up work prematurely as they
approach what they believe is their context limit."_ Opus 4.5 had strong context anxiety, enough that
resets were essential; Opus 4.6 largely eliminated it, so the build could run as one continuous session
with automatic compaction — and the reset machinery (orchestration complexity, token overhead, latency)
could be dropped.

## 7. Every component encodes a model-capability assumption — stress-test and prune

The meta-principle that ties the others together:

> "Every component in a harness encodes an assumption about what the model can't do on its own, and those
> assumptions are worth stress testing, both because they may be incorrect, and because they can quickly go
> stale as models improve." — Harness Design

So **re-audit the whole harness on every model release** and **remove non-load-bearing pieces one at a time,
with measurement** — a radical cut hides which pieces were load-bearing. The evaluator in particular is not
a fixed yes/no: _"It is worth the cost when the task sits beyond what the current model does reliably solo"_
(Harness Design) — its value is capability-relative and moves outward as models improve. Across the V1→V2
narrative, context resets were dropped, then the sprint construct, while the planner stayed. The closing
frame:

> "The space of interesting harness combinations doesn't shrink as models improve. Instead, it moves, and
> the interesting work for AI engineers is to keep finding the next novel combination." — Harness Design

## 8. One harness, many providers — keep shared layers provider-agnostic (ralphctl extension)

Not from the articles, but a direct consequence of §1's ACI discipline and §7's stress-test rule, and
load-bearing for ralphctl specifically: ralphctl runs **one harness across three provider backends** —
Claude Code, GitHub Copilot, OpenAI Codex. A component that works for one provider but silently degrades
the others is a portability bug, not a feature.

The rule: every **shared** layer — chain primitives, flows, prompt templates, and the signal contract —
must read the same on all three providers. Provider-specific behaviour belongs behind the **adapter /
`_engine` sibling-isolation seam** and **per-provider effort resolution**, never baked into shared prompt
text or the contract.

The sharpest trap is **reasoning elicitation**. Providers expose reasoning differently: Claude has native
extended thinking with reasoning-effort levels; OpenAI o-series / Codex have native _hidden_ reasoning
driven by a reasoning-effort parameter and do not honor `<thinking>`-tag instructions the way Claude does;
Copilot wraps varied models with varied support. So hardcoding `<thinking>` scaffolding — or any tag-shaped
"reason here" instruction — into a shared template helps one provider and degrades the others (duplicated or
ignored reasoning, wasted tokens, brittle parsing). Defer reasoning to each provider's **native effort
mechanism**, keep shared prompt text neutral, and never depend on one model's reasoning _output shape_.

Litmus test: if a prompt or contract assumes one model's output discipline — thinking tags, a specific
tool-call shape, a reasoning preamble — push that assumption down to the adapter, or remove it.

---

## How this maps to ralphctl

Pointers, not documentation — `.claude/docs/HARNESS-PRINCIPLES.md` holds the authoritative
`applied`/`partial`/`gap` status and exact anchors.

| Theme                          | ralphctl surface                                                                                                                                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| § 1 ladder / workflow-vs-agent | Five chain primitives `element` / `leaf` / `sequential` / `loop` / `guard` (`src/application/chain/`); flows are predefined code paths registered in `src/application/registry.ts`. Adding a sixth primitive is the canonical "climb reluctantly" pushback.                                               |
| § 2 externalized state         | Progress journal (`src/application/flows/implement/leaves/progress-journal.ts`, seeded by `create-sprint/leaves/init-progress-journal.ts`); git commits per attempt; per-sprint JSON (`sprint.json` / `tasks.json`) with task pass/verify flags; cross-sprint learnings via the `distill-learnings` flow. |
| § 3 two-phase prompt           | `plan` flow is the initializer (expands a ticket list into `tasks.json`); `implement` per-task chains are the per-session coding agents that re-orient from the journal + git + spec.                                                                                                                     |
| § 4 clean-state + self-verify  | One task at a time; pre/post-task verify gate with attribution; commit-then-update-journal close-out (`flows/implement/leaves/`).                                                                                                                                                                         |
| § 5 generator / evaluator      | `flows/implement/leaves/generator.ts` + `evaluator.ts`; skeptical evaluator template at `src/integration/ai/prompts/evaluate/template.md`; plateau + escalation guard the loop.                                                                                                                           |
| § 6 reset vs compaction        | Session scoping via `AsyncLocalStorage` (`src/application/session/session.ts`); prompt templates state the fresh-vs-prior-context convention explicitly.                                                                                                                                                  |
| § 7 prune on model bump        | `HARNESS-PRINCIPLES.md` rows 14/18 + the mechanized model-catalog fingerprint test (`tests/unit/business/task/escalation-map.test.ts`).                                                                                                                                                                   |

---

## Sources

- **Building Effective Agents** — Anthropic Engineering, Dec 19 2024 (examples since updated).
  https://www.anthropic.com/engineering/building-effective-agents
- **Effective Harnesses for Long-Running Agents** — Anthropic Engineering.
  https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- **Harness Design for Long-Running Application Development** — Prithvi Rajasekaran (Anthropic Labs),
  Mar 24 2026. https://www.anthropic.com/engineering/harness-design-long-running-apps
