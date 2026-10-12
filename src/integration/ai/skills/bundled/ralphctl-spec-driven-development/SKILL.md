---
name: ralphctl-spec-driven-development
description: Requirements discipline for sharpening the ticket or idea a requirements session already produces into a real spec — a clear objective, explicit boundaries, testable success criteria, surfaced assumptions, and named open questions, kept in sync as decisions change. Use when a ticket or idea is vague, bundles several capabilities, or states goals that cannot yet be checked. Adds no files and no approval steps of its own; the session's requirements body is the spec and its approval gate is the review.
license: MIT
---

# Spec-Driven Development

> Adapted from [addyosmani/agent-skills — "Spec-Driven Development"](https://github.com/addyosmani/agent-skills)
> (MIT). Adapted for ralphctl's harness contract.

Code without a spec is guessing. In ralphctl the spec already has a home: the requirements body the
refine or ideate session produces is what the planner and every implementing session build against. This
skill is the discipline for making that body a real spec — specific enough that two engineers reading it
would build the same thing — not a second artifact beside it.

**What this skill does not add.** No separate spec, plan, or to-do files, and no extra review stops. The
session's prompt owns the output (a single signal in `signals.json`), the section layout, and the
operator approval gate; follow those exactly. The prompt's approval gate _is_ the human review of the
spec — run it as the prompt describes, and do not end the session early to wait for a review the gate
already provides.

## When this applies

- **Refine** — the primary home: turn one ticket into requirements whose scope, criteria, and open
  questions are explicit. Stay implementation-agnostic, as the refine prompt requires.
- **Ideate** — Phase 1 (the WHAT): the same discipline before any planning. Phase 2 then inherits the
  approved success criteria as the raw material for each task's verification criteria.

**When not to reach for the full discipline:** a ticket that is already unambiguous and self-contained.
It still needs acceptance criteria — a two-line spec is fine — but not a ceremony.

## Scope check first

Most tickets describe one capability. Before specifying, check whether this one bundles several that
could be built and verified independently:

- It names distinct capabilities with their own users or data.
- Its acceptance criteria fall into groups that could ship and be checked separately.
- One part could be cut or replaced without rewriting the others' requirements.

When it does, say so before writing criteria. Propose the split to the operator — one ticket per
capability, or one numbered topic block per capability when the session's output format supports
multi-topic requirements — and name the dependency direction between them (which one has to exist
first). Dependencies point one way; if two parts each need the other, they are one capability. Keep the
names you give each part stable once chosen, so later tasks can refer to them without guessing.

## Surface assumptions before writing

Before drafting any criteria, list what you are assuming — about the user, the scope, the data, the
platform. Do not silently fill an ambiguous requirement: assumptions are the most dangerous form of
misunderstanding, and surfacing them before anything is built is the entire point of a spec.

Turn each assumption that matters into a question for the operator, using the question format the
session's prompt defines — one concern per question, most critical first. An assumption the operator
cannot settle in this session becomes an open question, not a silent default.

## What the spec must pin down

Fill the session's own section layout with these four things. They are content to supply, not an
extra template.

1. **Objective** — what is being built, for whom, and why. Name the user and the observable behaviour
   they need. If you cannot state what success looks like in a sentence, the objective is not ready.
2. **Boundaries** — what is in scope, what is explicitly out, and what is deferred. Include the
   behavioural constraints the result must always respect or never violate (it must never lose
   unsaved work; it must work offline) — phrased as observable behaviour, not as a design.
3. **Success criteria** — specific, testable conditions, one happy path plus each real alternate and
   error case. A criterion that cannot fail is not a criterion.
4. **Open questions** — anything still unresolved, named plainly with what would resolve it. A question
   that needs the codebase to answer is recorded as needing investigation — do not go exploring the
   repository mid-interview to settle it when the session's prompt keeps this phase source-free.

Commands, project structure, code style, and testing strategy are part of a classic engineering spec
but not of these requirements. They are HOW, and the HOW belongs to planning: the planner derives it
from the repository and the project's own tooling. Writing them into the requirements pre-empts
decisions that are not yours to make here.

### Reframe vague goals as success criteria

When a requirement is a direction rather than a destination, translate it into conditions that can be
checked, then confirm them with the operator:

```
REQUIREMENT: "Make the export faster"

REFRAMED SUCCESS CRITERIA:
- Exporting 10,000 records completes within 5 seconds on the reference dataset
- Progress is visible within 1 second of starting the export
- A cancelled export leaves no partial file behind
→ Are these the right targets?
```

"Faster", "robust", and "user-friendly" are not criteria. Numbers, observable states, and named failure
behaviours are.

## Keeping the spec alive

The spec is only useful while it matches the decisions behind it.

- **Update when a decision changes.** When an operator answer overturns an earlier assumption, revise
  every criterion that depended on it before presenting — do not leave a stale criterion beside the new
  one.
- **Update when scope changes.** Anything added or cut moves into or out of the scope section in the same
  revision, not "later".
- **Honour settled decisions.** Choices already recorded for this sprint stand; do not re-open them
  without saying why.
- **Surface drift instead of absorbing it.** When something learned after approval contradicts an
  approved requirement (in ideate, exploring the repository during planning can reveal this), raise it
  with the operator rather than quietly planning against a different spec. Record the outcome as a
  `decision` signal when the prompt's output-contract section lists it; otherwise carry it in the
  required signal's own content.
- **The approved body is the source of truth downstream.** Tasks trace to it and implementing sessions
  verify against it. If the direction changes after approval, that is a new refinement, not a silent
  divergence between the spec and the code built from it.

## Common rationalisations

| Rationalisation                                  | Reality                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| "This is simple, it doesn't need a spec"         | Simple tickets don't need _long_ specs, but they still need acceptance criteria. Two lines is fine.       |
| "The planner will figure out the details"        | The planner decides HOW. If WHAT is ambiguous, it guesses — and every task inherits the guess.            |
| "The operator knows what they want"              | Even clear requests carry implicit assumptions. The spec's job is to surface them.                        |
| "Requirements will change anyway"                | That is why the spec is kept in sync, not skipped. An outdated criterion is caught; a missing one is not. |
| "It's one big feature; splitting it is overhead" | Criteria that fall into independent groups make every downstream task reason over the whole contract.     |
| "I'll note the open question later"              | An open question left unnamed becomes a silent default in the plan.                                       |

## Red flags

- A success criterion that cannot fail, or one phrased as "should work well".
- An assumption baked into a criterion without ever being stated or confirmed.
- Scope with an "in" list and no "out" list.
- Implementation choices (storage, libraries, architecture) written into requirements that are meant to
  stay implementation-agnostic.
- One set of requirements spanning several independently testable capabilities, with no split proposed.
- A criterion left unchanged after the answer it depended on was overturned.
- An open question resolved by guessing instead of asking or naming it.

## Self-check before presenting for approval

- [ ] The objective names the user, the behaviour, and what success looks like.
- [ ] Scope says what is in, what is out, and what is deferred.
- [ ] Every criterion is specific and testable, with error and alternate cases where the behaviour has
      them.
- [ ] Every assumption that matters was confirmed or is listed as an open question.
- [ ] A ticket that bundles independent capabilities had a split proposed, with dependency direction.
- [ ] No criterion is stale relative to a later decision.
- [ ] Nothing in the body pre-empts a HOW decision that belongs to planning.
