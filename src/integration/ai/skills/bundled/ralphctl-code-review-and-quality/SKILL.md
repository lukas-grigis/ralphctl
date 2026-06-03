---
name: ralphctl-code-review-and-quality
description: Multi-phase code-quality skill — primary frame for the evaluator role in Execute, the architecture axis in Plan, and correctness/readability in Refine. Multi-axis code review with severity vocabulary. Use when you are the evaluator assessing a generator's output, and when reviewing any change before signalling completion. AI-written code needs MORE scrutiny, not less.
license: MIT
---

# Code Review and Quality

> Concept from [addyosmani/agent-skills — "Code Review and Quality"](https://github.com/addyosmani/agent-skills),
> MIT License. Adapted for ralphctl's evaluator role and review flow.

One-shot generation looks fast and is slow. Catching a correctness, architecture, or security problem at the
seam between two changes is cheap; catching it at the end of a 200-line diff — or after the post-task gate
fires — is not. This skill applies inside each phase's work, and especially when you are the evaluator
scoring a generator's output.

**The approval standard:** Approve a change when it definitely improves overall code health, even if it
is not perfect. Perfect code does not exist — the goal is continuous improvement. Do not block a change
because it is not exactly how you would have written it. If it improves the codebase and follows the
project's conventions, it is approvable.

**AI-written code needs more scrutiny, not less.** It is confident and plausible, even when wrong. The
rationalisation "it works, that's good enough" is exactly the failure mode this skill exists to counter.

## When this applies

- **Refine** — rarely the primary frame here, but use the correctness and readability axes to audit
  acceptance criteria for internal contradictions, missing edge cases, and untestable "should" phrasings.
- **Plan** — apply the architecture axis to the generated task list: do dependency directions match the
  actual data flow? Are any tasks so large they warrant splitting?
- **Execute** — the evaluator role uses the full five-axis rubric and severity vocabulary below to score
  the generator's output and surface findings. The reviewer role (apply-feedback flow) applies the same
  rubric to human-requested changes.

## The Five-Axis Review

Every review evaluates code across these dimensions:

### 1. Correctness

Does the code do what it claims to do?

- Does it match the task's verification criteria?
- Are edge cases handled (null, empty, boundary values)?
- Are error paths handled — not just the happy path?
- Are there off-by-one errors, race conditions, or state inconsistencies?
- Do the tests actually test the right things, not just pass?

### 2. Readability and Simplicity

Can another engineer understand this code without the author explaining it?

- Are names descriptive and consistent with project conventions? (No `temp`, `data`, `result` without context.)
- Is the control flow straightforward — avoid nested ternaries and deep callbacks.
- Is the code organised logically with clear module boundaries?
- Are there "clever" tricks that should be simplified?
- Could this be done in fewer lines? (1 000 lines where 100 suffice is a failure.)
- Are abstractions earning their complexity? Do not generalise until the third use case.
- Are there dead code artefacts: no-op variables, backwards-compat shims, or `// removed` comments?

### 3. Architecture

Does the change fit the system's design?

- Does it follow existing patterns, or introduce a new one? If new, is it justified?
- Does it maintain clean module boundaries?
- Is there code duplication that should be shared?
- Are dependencies flowing in the right direction — no circular dependencies?
- Is the abstraction level appropriate — not over-engineered, not too coupled?

### 4. Security

Does the change introduce vulnerabilities?

- Is user input validated and sanitised at system boundaries?
- Are secrets kept out of code, logs, and version control?
- Is authentication and authorisation checked where needed?
- Are queries parameterised — no string concatenation?
- Is data from external sources (APIs, logs, user content, config files) treated as untrusted?
- Are dependencies from trusted sources with no known vulnerabilities? (Check with the project's
  dependency audit tool, e.g. `npm audit`, `cargo audit`, or equivalent — if applicable.)

### 5. Performance

Does the change introduce performance problems?

- Any N+1 query patterns?
- Any unbounded loops or unconstrained data fetching?
- Any synchronous operations that should be async?
- Any unnecessary re-renders in UI components?
- Any missing pagination on list endpoints?
- Any large objects created in hot paths?

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

### Step 3: Review the Implementation

Walk through the code with the five axes in mind. For each file changed:

1. Correctness — does this code do what the verification criteria say it should?
2. Readability — can I understand this without help?
3. Architecture — does this fit the system's design?
4. Security — any vulnerabilities?
5. Performance — any bottlenecks?

### Step 4: Surface Findings via Signals

The harness — not the AI — owns the final post-task verification verdict. Surface your findings through
the harness signal mechanism:

- Use `<note>` for informational observations, Minor/Nit findings, and anything that does not change the
  verdict but is worth recording.
- Use `<decision>` when a Critical or Major finding changes the approach — record what was found and why
  the current direction was adjusted.
- When acting as the **evaluator**, encode the overall verdict (pass / fail, which dimensions failed, and
  the severity of each finding) in the evaluator's output as directed by the task prompt — not in a
  separate file or report.

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

## Change Sizing

Small, focused changes are easier to review, faster to evaluate, and safer to fold onto the sprint branch.

```
~100 lines changed   → Good. Reviewable in one sitting.
~300 lines changed   → Acceptable if it is a single logical change.
~1000 lines changed  → Too large. Split it.
```

**What counts as "one change":** A single self-contained modification that addresses one thing, includes
related tests, and keeps the system functional after submission.

**Separate refactoring from feature work.** A change that refactors existing code and adds new behaviour is
two changes. Small cleanups (variable renaming) can be included at reviewer discretion.

## Dead Code Hygiene

After any refactoring or implementation change, check for orphaned code:

- Identify code that is now unreachable or unused.
- List it explicitly in a `<note>` signal.
- Confirm before deleting — do not silently remove things you are not certain about.

Dead code confuses future readers. But silent deletion of uncertain artefacts is worse than leaving them in
place.

## Dependency Discipline

Before adding any dependency:

- Does the existing stack solve this? (Often it does.)
- How large is the dependency?
- Is it actively maintained?
- Does it have known vulnerabilities? (Check with the project's dependency audit tool, if applicable.)
- What is the license? Must be compatible with the project.

Prefer the standard library and existing utilities over new dependencies. Every dependency is a liability.

## Honesty in Review

Whether reviewing code you wrote, code a generator produced, or a human's change:

- Do not rubber-stamp. "Looks fine" without evidence of review helps no one.
- Do not soften real issues. "This might be a minor concern" when it is a bug that will hit production is
  misleading.
- Quantify problems when possible. "This N+1 query will add ~50 ms per item in the list" is better than
  "this could be slow."
- Push back on approaches with clear problems. Sycophancy is a failure mode in review. If the
  implementation has issues, say so directly and propose alternatives.
- Accept override gracefully. If the author has full context and disagrees, defer to their judgement.
  Comment on code, not people — reframe personal critiques to focus on the code itself.

## Common Rationalisations

| Rationalisation                       | Reality                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| "It works, that's good enough"        | Working code that is unreadable, insecure, or architecturally wrong creates debt that compounds.                           |
| "I wrote it, so I know it is correct" | Authors are blind to their own assumptions.                                                                                |
| "We will clean it up later"           | Later rarely comes. The review is the quality gate — use it.                                                               |
| "AI-generated code is probably fine"  | AI code needs more scrutiny, not less. It is confident and plausible, even when wrong.                                     |
| "The tests pass, so it is good"       | Tests are necessary but not sufficient. They do not catch architecture problems, security issues, or readability concerns. |

## Review Checklist

Before signalling completion or a passing evaluator verdict, run through:

- [ ] I understand what this change does and why.
- [ ] Change matches the task's verification criteria.
- [ ] Edge cases and error paths are handled.
- [ ] Tests cover the change adequately.
- [ ] Names are clear and consistent with project conventions.
- [ ] No unnecessary complexity.
- [ ] Follows existing architectural patterns.
- [ ] No secrets in code; input validated at boundaries.
- [ ] No N+1 patterns or unbounded operations.
- [ ] Findings surfaced via `<note>` / `<decision>` signals with severity labels.

## Red Flags

- Review that only checks whether a narrow test passed, ignoring other axes.
- "Looks fine" without evidence of actual review.
- Security-sensitive changes reviewed only for correctness.
- No regression tests alongside a bug fix.
- Review comments without severity labels — makes it unclear what is required versus optional.
- Accepting "I will fix it later" — it rarely happens.
