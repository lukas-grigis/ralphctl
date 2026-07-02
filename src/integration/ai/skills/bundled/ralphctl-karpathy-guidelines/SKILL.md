---
name: ralphctl-karpathy-guidelines
description: Behavioural guardrails against four empirical LLM coding failure modes — silent assumptions, over-complication, orthogonal damage to code you don't fully understand, and declaring done without verification. Use when writing, reviewing, or refactoring code to surface assumptions early, keep changes proportionate to the task, and loop until explicit success criteria pass; broader than the implementation-choice ladder in ralphctl-ponytail or the scope checklist in ralphctl-surgical-simplicity, which it complements rather than duplicates.
---

# Karpathy Guidelines

> Distilled from Andrej Karpathy's public commentary on LLM coding pitfalls — his January 2026
> [X post on agentic coding](https://x.com/karpathy/status/2015883857489522876). Clean-room —
> concepts only, not copied text.

Karpathy's observation, after moving most of his coding to agents: the mistakes agents make are
not random — they cluster into four recurring failure modes. Each mode below pairs the failure
with the counter-habit that prevents it. Treat these as standing behavioural rules for every
coding turn, not a checklist to run once.

## When this applies

- **Plan** — modes 1 and 4 dominate: a plan built on an unstated assumption, or with success criteria that can't be checked, fails before any code exists.
- **Execute** — all four modes: every generation, edit, and refactor is an opportunity to silently assume, over-build, damage bystander code, or stop before verifying.

## Mode 1 — Silent assumptions

The failure: making a plausible assumption on the operator's behalf and running with it
unchecked — not managing your own confusion, not surfacing inconsistencies, not presenting
trade-offs, not pushing back when the request conflicts with what the code shows.

The counter-habit:

- When the task is ambiguous, name the ambiguity before acting. With an interactive channel, ask; without one, state the interpretation you chose and why in a `<decision>` or `<note>` signal, then proceed with the least-surprising reading.
- When the task's description contradicts what you find in the code, surface the contradiction — do not quietly pick a side.
- When two implementations satisfy the words of the task but differ in consequence, present the trade-off rather than silently committing to one.
- Push back when the request is likely a mistake. Deference that ships a wrong change is not helpfulness.

## Mode 2 — Over-complication

The failure: bloated abstractions, over-general APIs, a thousand lines where a hundred would do —
and dead code left behind because nothing forced its cleanup.

The counter-habit:

- Write the simplest version that solves the stated problem. Generality earns its place only when a second concrete caller exists.
- Prefer one plain function over a class hierarchy, a flag, or a plugin point invented for a future that was never requested.
- When your change makes code unreachable, delete that code in the same change — dead code you created is your cleanup, not a future task.
- Re-read your diff asking one question: what can be removed without failing the task?

## Mode 3 — Orthogonal damage

The failure: changing or deleting comments, formatting, or neighbouring code that the task never
asked about — side effects on things you did not fully understand, orthogonal to the goal.

The counter-habit:

- Preserve comments you did not write unless your change makes them false — then update them, don't drop them.
- Leave formatting, naming, and structure outside your change's boundary untouched, even when you disagree with it.
- Never edit code you don't understand just because it sits next to code you do; the exception is when the task itself is to change that code — then understanding it first is the task.
- If your tooling reformats or rewrites beyond your intended lines, trim the diff back to what the task requires.

## Mode 4 — Unverified completion

The failure: declaring the work done because the code looks right, without ever defining what
"done" means or demonstrating it.

The counter-habit:

- Before writing code, state the success criteria as checkable predicates — a test that passes, a command that exits cleanly, an observable behaviour.
- After each meaningful change, run the narrowest check that could falsify it; do not batch many unverified changes and hope.
- Loop: change → check → compare against the criteria — until the criteria demonstrably pass. "It should work now" is a hypothesis, not a result.
- Reaching the criteria is your job; the harness owns the final post-task verify gate — arrive at it in a demonstrably clean state rather than certifying completion yourself.

## Self-check before finishing

- [ ] Every assumption I made is either confirmed or explicitly surfaced.
- [ ] Nothing in the diff exists "for later" — every line serves the stated task.
- [ ] No comment, formatting, or bystander code changed without a task-driven reason.
- [ ] The success criteria were stated up front and each one has been demonstrated, not assumed.
