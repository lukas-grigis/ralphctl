---
name: ralphctl-writing-for-agents
description: How to write documents an AI agent consumes — project context files (AGENTS.md, CLAUDE.md, and similar), skills, task specs, and requirements. Covers trigger-worded pointers, the cost of always-loaded context, steps that end on checkable completion criteria, leading words, positive phrasing over prohibitions, and pruning restatements, no-ops, and stale lines. Use when drafting or editing any of those documents.
license: MIT
---

# Writing for Agents

> Adapted from [mattpocock/skills — "Writing for Agents"](https://github.com/mattpocock/skills) (MIT).
> Adapted for ralphctl's harness contract.

A reference for writing any document an agent consumes: a project context file, a skill, a task spec, a
set of requirements. The packaging differs; the writing does not. The same levers make each one
predictable — the agent takes the same _process_ every run, rather than producing the same output.

The session's prompt still owns the output: its length targets, required sections, and what-to-leave-out
rules win over anything here.

## When this applies

- **Readiness** — the context-file proposal. Every line is loaded into every future session, so each one
  must change behaviour versus the default. Point at what the environment already states instead of
  restating it, but keep every exact command the prompt asks for (build and test lines, setup and verify
  skill bodies).
- **Refine** — the requirements are read by the planner and every implementing session. Give each
  criterion a checkable completion condition, keep each meaning in one place, and phrase the target
  behaviour positively.

## Context pointers

A **context pointer** is a line in context that names material outside it and encodes when to reach it —
a skill's description, or a context-file line naming a doc. The pointer's _wording_, not its target,
decides when and how reliably the agent reaches the material. A must-have target behind a weakly worded
pointer is a variance bug: sharpen the wording first; inline the material only if that fails.

A pointer states what the material is and lists the **branches** — distinct cases — that should trigger
it. Every word of an always-loaded pointer costs on every turn, so prune it hardest:

- **Front-load the leading word**; the start of the pointer does the triggering.
- **One trigger per branch.** Synonyms naming one branch are one branch written twice.
- **Cut identity the body already carries.**

## The two loads

- **Context load** — always-loaded material (a context-file line, a skill description) spends tokens and
  attention every turn, whether or not it fires.
- **Cognitive load** — the human has to know which documents exist and when each matters. Spend it where
  human judgement matters; remove it where it does not.

Material behind a pointer escapes context load at the price of the pointer's own line.

## Information hierarchy

A document mixes **steps** (ordered actions) and **reference** (definitions, rules, facts consulted on
demand). Place each piece on a ladder ranked by how immediately the agent needs it:

1. **In-file steps** — what the agent does, in order.
2. **In-file reference** — consulted on demand; a flat set of peer rules is fine.
3. **Disclosed reference** — material in another file, reached through a pointer only when needed.

Inline what every branch needs; disclose what only some branches reach. Keep a concept's definition,
rules, and caveats together under one heading rather than scattered. The failure mode is **sprawl** — a
document so long that attention thins across it even when every line is live. In a session that writes
only its proposal, disclose by pointing at a file that already exists.

## Steps and completion criteria

Every step ends on a **completion criterion** — the condition that tells the agent it is done.

- **Clarity** — can the agent tell done from not done? A vague bound ("once understanding is reached")
  invites premature completion, with attention slipping to the steps still ahead. Sharpen the bound
  first. Hiding later steps only helps across a real context boundary (a hand-off to a separate session
  or task).
- **Demand** — how much the criterion requires. "Every modified model accounted for" forces thorough work
  where "produce a change list" does not. Demand binds flat reference too: "every rule applied".

The strongest criteria are both checkable and exhaustive.

## Leading words

A **leading word** is a compact concept the model already knows — _tight_ (a tight feedback loop),
_red_ (a test that fails on the bug), _tracer bullet_. Repeated as a token, it anchors a whole region of
behaviour in few words by recruiting priors the model already holds. Hunt for passages that spell out a
triad or a sentence where one such word would do.

**Prohibitions backfire.** Naming the forbidden behaviour puts it in context and makes it more
available. State the target behaviour ("write one-line comments"). Keep a prohibition only as a hard
guardrail you cannot phrase positively, and pair it with the positive target.

## Pruning

- **One meaning, one place.** Duplication costs maintenance and tokens and inflates a meaning's
  prominence. (A leading word repeats a token on purpose, never the meaning.)
- **The environment is a source of truth.** Config files, the directory layout, `--help` output, and
  what a manifest script does already state themselves; a document that restates them is a cache that
  goes stale. Which command to run is different: where the document exists to tell the agent what to run,
  or the output contract asks for commands, give the exact runnable command, checked against the manifest.
  Beyond that, write down what the agent cannot find by looking — the unwritten convention, the reason
  behind a choice, the gotcha no config admits.
- **Relevance.** A line that never bears on the task, or describes behaviour that has since changed, is
  sediment. Remove it.
- **No-ops.** An instruction the model already follows by default says nothing. Delete the whole
  sentence. A word too weak to beat the default (_be thorough_) needs a stronger word, not more words.

## Self-check

- [ ] Every always-loaded line changes behaviour versus the default.
- [ ] Each pointer front-loads its trigger and lists one trigger per branch.
- [ ] Every step ends on a checkable completion criterion.
- [ ] Nothing restates what the environment already states, and every command the contract asks for is
      exact and runnable.
- [ ] Target behaviours are phrased positively.
- [ ] The prompt's own length and section rules are met.
