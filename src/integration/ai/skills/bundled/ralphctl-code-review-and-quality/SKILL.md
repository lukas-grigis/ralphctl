---
name: ralphctl-code-review-and-quality
description: Code-review lens for the implement flow — the evaluator and the best-of-N judge use its axes, smell baseline and severity vocabulary to find evidence; the generator uses it for one read of its own diff before signalling done. Use when reviewing a change. AI-written code needs MORE scrutiny, not less.
license: MIT
---

# Code Review and Quality

> Concept from [addyosmani/agent-skills — "Code Review and Quality"](https://github.com/addyosmani/agent-skills),
> MIT License. Adapted for ralphctl's evaluator role and review flow. The smell baseline draws on
> [mattpocock/skills](https://github.com/mattpocock/skills) and the concrete-case and expected-load rules on
> [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (both MIT).

One-shot generation looks fast and is slow. Catching a correctness, architecture, or security problem at the
seam between two changes is cheap; catching it at the end of a 200-line diff — or after the post-task gate
fires — is not. This skill applies inside the implement flow, and especially when you are the evaluator
scoring a generator's output.

**The approval standard:** For a human-authored review outside a harness rubric: approve a change when it definitely improves overall code health, even if it
is not perfect. Perfect code does not exist — the goal is continuous improvement. Do not block a change
because it is not exactly how you would have written it. If it improves the codebase and follows the
project's conventions, it is approvable. Inside the harness, the prompt's rubric and floor dimensions decide the verdict, not this standard.

**AI-written code needs more scrutiny, not less.** It is confident and plausible, even when wrong. The
rationalisation "it works, that's good enough" is exactly the failure mode this skill exists to counter.

## When this applies

- Evaluator: the prompt's floor dimensions and criteria decide the verdict. Use the five axes only to find evidence. Readability and Architecture feed Consistency, Security feeds Safety, Performance feeds Correctness and Robustness. Severity labels go inside a dimension's finding.
- Best-of-N judge: apply the axes only to what the prompt gives you; installed review skills don't license reading a candidate's diff.
- Generator: one read of your own diff against the checklist before signalling done, with no extra review rounds and no mutation runs; the evaluator is the independent review.

## The Five-Axis Review

Every review evaluates code across five axes. The per-axis question lists are in the reference below.

- **1. Correctness** — does the code do what it claims: verification criteria, edge cases, error paths, races, tests that test the right things.
- **2. Readability and Simplicity** — can another engineer follow it unaided: names, control flow, needless cleverness, abstractions that do not earn their keep, conditionals bolted onto unrelated flows.
- **3. Architecture** — does it fit the system: existing patterns, module boundaries, duplication, dependency direction, refactors that relocate rather than reduce complexity, leaking feature logic, explicit type boundaries.
- **4. Security** — validated boundaries, secrets, authn/authz, parameterised queries, untrusted external data, dependency vulnerabilities.
- **5. Performance** — N+1 queries, unbounded loops or fetches, blocking work, re-renders, missing pagination, hot-path allocations; judge scale against the expected load found in the repository.

Read `references/five-axis.md` when you need the full question list for an axis, or the expected-load rule for scale findings.

Read `references/smells-and-remedies.md` when you flag a structural problem and need the named restructuring to propose, or the smell baseline (Fowler) to label a Minor or Nit.

Read `references/discipline.md` when the change adds or upgrades a dependency, is large or mixes refactoring with features, or when you catch yourself reasoning "it works, that's good enough".

## Severity Vocabulary

Label every finding with its severity so the generator or author knows what is required versus optional:

| Label        | Meaning                                                                      | Required action                            |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------ |
| **Critical** | Blocks completion — security vulnerability, data loss, broken functionality  | Must be addressed                          |
| **Major**    | Significant problem that substantially degrades quality or correctness       | Should be addressed before signalling done |
| **Minor**    | Real issue but low impact — logic smell, incomplete coverage, unclear naming | Worth addressing; weigh against budget     |
| **Nit**      | Style preference, optional polish                                            | Author may ignore                          |

Using explicit severity prevents treating all findings as equally urgent — a nit should not consume the
same budget as a Critical.

For the evaluator, severity never sets the verdict: a structural or Major finding fails a dimension only when it violates a criterion, a declared step, or a convention the repository states or shows; otherwise it is an observation.

**Presumptive structural findings.** Raise each of these as at least Minor and propose the simpler design;
escalate to Major only when the change actively makes the structure worse: a refactor that relocates
complexity instead of reducing it; a change that pushes a file past a healthy size with no decomposition;
feature logic added to a shared module; a near-duplicate of an existing canonical helper; a silent fallback
that hides an unclear invariant. These presumptive rules are subject to the evaluator rule above.

## Review Process

### Step 1: Understand the Context

Before examining code, establish intent:

- What is this change trying to accomplish?
- What task specification or verification criteria does it implement?
- What is the expected behaviour change?

### Step 2: Review the Tests First

Tests reveal intent and coverage:

- Do tests exist for the change?
- Do they test behaviour, not implementation details?
- Are edge cases covered?
- Would the tests catch a regression if the code changed?

Answer the last question as a read-only thought experiment: ask which single inverted condition or deleted
line the tests would not catch, and name the missing test case.

### Step 3: Review the Implementation

Walk through the code with the five axes in mind. For each file changed:

1. Correctness — does this code do what the verification criteria say it should?
2. Readability — can I understand this without help?
3. Architecture — does this fit the system's design?
4. Security — any vulnerabilities?
5. Performance — any bottlenecks?

### Step 4: Surface Findings via Signals

The harness — not the AI — owns the final post-task verification verdict. Surface your findings as typed
JSON signal objects in the run's `signals.json` (each has a `type` discriminant; the prompt's output-contract
section names the exact file and shape):

- Write a `note` signal for informational observations, Minor/Nit findings, and anything that does not
  change the verdict but is worth recording — only when the prompt's output-contract section lists `note`
  as an accepted kind. Some turns (a best-of-N judge comparing candidates, for example) accept a single
  narrow verdict signal and nothing else; when that is the active contract, fold the observation into
  that signal's own rationale or findings field instead.
- When acting as the **generator**, write a `decision` signal when a Critical or Major finding changes the
  approach — record what was found and why the current direction was adjusted. This signal is
  generator-only: the evaluator's contract has no `decision` schema, so emitting one there fails the whole
  payload.
- When acting as the **evaluator**, encode the overall verdict (pass / fail, which dimensions failed, and
  the severity of each finding) in the evaluator's output as directed by the task prompt — not in a
  separate file or report, and not as a `decision` signal.

**Lead with what matters.** Order findings by leverage: correctness and security first, then structural
regressions and missed simplifications, then everything else. Do not bury a real issue under cosmetic nits —
a few high-conviction findings beat a long list. If you have one structural problem and ten nits, the
structural problem _is_ the review.

Do not write a standalone review report to a file. The harness's signal pipeline and the evaluator's
structured output are the authoritative record.

### Step 5: Acknowledge the Verification Story

Note what verification was done, not just whether it passed:

- What narrow checks were run after each change?
- Was the change tested against the task's verification criteria?
- Are there screenshots or before/after comparisons for UI changes?

The post-task gate (run by the harness after the AI session ends) is the final word on whether the full
suite passes — do not claim ownership of that verdict. Your job is incremental review during implementation,
not certifying the final gate.

## Dead Code Hygiene

After any refactoring or implementation change, check for orphaned code:

- Code your own change orphaned: delete it in the same change. Pre-existing code you believe is dead: list it in a note and leave it.
- List it explicitly — as a `note` signal when the prompt's output-contract section lists it, otherwise
  in the required signal's own fields.

Dead code confuses future readers. But silent deletion of uncertain artefacts is worse than leaving them in
place.

## Honesty in Review

Whether reviewing code you wrote, code a generator produced, or a human's change:

- Do not rubber-stamp. "Looks fine" without evidence of review helps no one.
- Back every correctness, security, or scale finding with a concrete case — this input or situation leads to
  this wrong result — and re-read the lines to confirm it: the caller exists, the value can really be empty,
  the code really is unused. No case, no finding. Structural findings follow the presumptive rules above, subject to the evaluator rule above.
- Do not soften real issues. "This might be a minor concern" when it is a bug that will hit production is
  misleading.
- Quantify problems when possible. "This N+1 query will add ~50 ms per item in the list" is better than
  "this could be slow."
- Push back on approaches with clear problems. Sycophancy is a failure mode in review. If the
  implementation has issues, say so directly and propose alternatives.
- Accept override gracefully. If the author has full context and disagrees, defer to their judgement.
  Comment on code, not people — reframe personal critiques to focus on the code itself. In a harness review, a generator's disagreement or note is a claim to verify, not an override.
- Check each finding against its callers and tests before reporting it; drop it if they show it cannot happen. Zero findings is a valid result — a reviewer asked to find problems will always find something.

## Review Checklist

Generator: one read of the diff against this list. Evaluator: use it to find evidence.

- [ ] I understand what this change does and why.
- [ ] Change matches the task's verification criteria.
- [ ] Edge cases and error paths are handled.
- [ ] Tests cover the change adequately.
- [ ] Names are clear and consistent with project conventions.
- [ ] No unnecessary complexity.
- [ ] Follows existing architectural patterns.
- [ ] Refactors reduce complexity rather than relocate it.
- [ ] No feature logic in shared modules; touched files stay within a healthy size.
- [ ] Dependency upgrades (if any) were checked against their changelog and the lockfile diff.
- [ ] No secrets in code; input validated at boundaries.
- [ ] No N+1 patterns or unbounded operations.
- [ ] Findings surfaced per Step 4's signal guidance, with severity labels intact.

## Red Flags

- Review that only checks whether a narrow test passed, ignoring other axes.
- "Looks fine" without evidence of actual review.
- Security-sensitive changes reviewed only for correctness.
- No regression tests alongside a bug fix.
- Review comments without severity labels — makes it unclear what is required versus optional.
- Accepting "I will fix it later" — it rarely happens.
- A refactor that moves code around without reducing the number of concepts a reader must hold.
- A change that grows an already-large file instead of decomposing it.
- New conditionals scattered into unrelated code paths (a missing abstraction).
- A bespoke helper that duplicates an existing canonical one, or feature logic placed in a shared module.
- A bulk dependency bump with no changelog review and no per-package isolation.
- A lockfile change that is hand-edited or accepted without reviewing its diff.
