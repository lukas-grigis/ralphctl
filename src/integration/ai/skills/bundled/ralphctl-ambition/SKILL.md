---
name: ralphctl-ambition
description: Raise the quality bar of requirements or a plan without growing its size — name the outcome behind the request, what a top practitioner would check, and an outside judge for each criterion; offer higher rungs to the operator, never adopt them silently. Use in ideate, refine or plan when a request seems to aim low.
---

# Ambition

> Distilled from Felix Rieseberg's article
> [How to be more ambitious: a tutorial for humans with models](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/).
> Prior art: [robonuggets/be-ambitious](https://github.com/robonuggets/be-ambitious).
> Clean-room — concepts only, not copied text.

The article's argument, in short: what a model can do is uneven and growing, so the limit on the
result is often what the person asking was willing to attempt. Requests aim low by habit. This
skill raises the bar a request sets — what "done well" means — while leaving its size alone.

Not for implementation or PR authoring.

## Deeper, not bigger

Ambition here means depth and rigour, never volume. A more ambitious requirement or plan has
sharper acceptance criteria, a clearer outcome, and checks a top practitioner would recognise. It
does not have more features, more tasks, or more files. If raising the bar would add scope, the
addition is a question for the operator, not a change you make.

## Altitude — the goal beyond the goal

Name, in one line, what the request is for: the outcome it should change once it ships. The
article's example is the step from fixing one crash to keeping an app crash-free. The line gives
every criterion something to aim at; it does not widen the work to cover that higher goal.

## Depth — what the best practitioner would check

Ask what the strongest practitioner in this field would check before calling the work done, and
turn the answer into acceptance or verification criteria inside the existing scope. Prefer the
instruments that practitioner actually uses — a measurement, a reproduction, a real data sample —
over their vocabulary. Make targets measurable where the domain allows it; where a number would be
invented, name the signal instead and leave the number as an open question.

## Range — other fields' methods

When a neighbouring field has a better method for the problem (a statistician's sampling, an
editor's read-aloud pass, a red team's adversarial input), borrow the method and state it as a
check. Borrow what those practitioners do, not how they talk; jargon without the method adds
nothing.

## Outside judge

Every criterion you raise names who or what judges it — something other than the author of the
work. A command, a test, a measurement, a reviewer: the judge must be able to say no. A criterion
with no judge is an aspiration; either find its judge or drop the raise.

## Missing access is an open question

When the higher bar depends on data, tools, environments, or people you cannot reach, say so as an
open question in the prompt's format. Never assume the access exists, and never lower the criterion
silently to fit what is at hand.

## Offer, don't adopt

A higher rung — a more demanding criterion, a higher outcome, a stricter target — is offered to the
operator as its own structured question, in the prompt's question format, before the document is
presented for approval. It is never folded into the approval options, and never written into the
document unasked. An approval covers only what was shown; a rung the operator did not see is not
approved. Without an interactive channel, record the rung as an open question or note, not as a
criterion.

## Precedence

The prompt wins over this skill wherever they disagree. Between skills: ambition decides what
"done well" means; ralphctl-ponytail, ralphctl-karpathy-guidelines and
ralphctl-code-simplification (when installed) decide the footprint. When they disagree on size, the
footprint wins — keep the higher bar only where it fits the smaller shape.

## When this applies

- **Refine** — Altitude is the operator's answer to the prompt's single "why"; take it as given. Do
  not ask a second why, do not propose an outcome, and do not mark any option as recommended. Depth
  may suggest what a top practitioner would check, phrased as an acceptance-criterion question for
  the operator — never written into the requirements unasked.
- **Plan** — no extra tasks or files. Raise depth only inside a ticket's scope, as sharper
  verification criteria the evaluator can run or cite. The outside judge in a plan is a command or
  the evaluator, never a person. A higher outcome goes into a question or a note, never into a
  criterion; the Outcome and Assumptions sections stay context.
- **Ideate** — ralphctl-idea-refinement, when installed, owns the variations, including its "10x
  version" and expert lens. This skill owns the outcome line, the judge for each criterion, and the
  depth target of the chosen direction.

## Self-check before presenting

- [ ] The outcome is named in one line, and the scope did not grow to chase it.
- [ ] Each raised criterion names a judge that can say no.
- [ ] Targets are measurable or left as an open question — none invented.
- [ ] Missing access is an open question, not an assumption.
- [ ] Every higher rung was offered as its own question before approval, not written in.
