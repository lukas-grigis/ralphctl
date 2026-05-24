---
name: harness-principles
description: "Auto-triggers on structural harness decisions: new chain primitive, new flow, remove evaluator, wrap evaluator, redesign harness, scaffolding, load-bearing, model upgrade, harness audit, refactor flow, sub-agent. Also triggers on file mentions of `src/application/chain/`, `src/application/flows/`, `src/integration/ai/providers/_engine/`. Instructs the agent to read the principles doc before proceeding."
when_to_use: 'When the user prompt contains any of: "chain primitive", "new flow", "remove evaluator", "wrap evaluator", "redesign harness", "scaffolding", "load-bearing", "model upgrade", "harness audit", "refactor flow", "sub-agent". Also when the prompt references `src/application/chain/`, `src/application/flows/`, or `src/integration/ai/providers/_engine/`. Not needed for pure business logic, UI, or persistence work that does not touch the chain or provider engine.'
---

# Harness Principles — Auto-trigger

This skill exists because the harness research evolves with model capability. What was load-bearing in
Opus 4.5 may be overhead in Opus 4.7. Without an explicit read-first gate, structural changes happen
without awareness of the research behind the current design.

**Before proceeding with any structural harness change:**

1. `Read .claude/docs/HARNESS-PRINCIPLES.md` in full.
2. Identify the relevant principle section(s) by name (e.g. "§ 14 Minimal scaffolding", "§ 7 Idle watchdog").
3. Note the current `ralphctl status` for each relevant principle (`applied` / `partial` / `gap`).
4. Proceed with the change, keeping the principle's intent visible in the diff.

If you are **removing** a harness component, confirm which principle the component implements and verify the
removal does not regress an `applied` row. If the removal moves a row from `applied` to `gap`, update
`HARNESS-PRINCIPLES.md` as part of the same commit.

If you are **adding** a new chain primitive — there are five and only five: `element` (interface), `leaf`,
`sequential`, `loop`, `guard`. Push back if a proposal adds a sixth. The principle behind this constraint
is § 14 (Minimal scaffolding) and the rationale is in `CLAUDE.md § Architecture`.
