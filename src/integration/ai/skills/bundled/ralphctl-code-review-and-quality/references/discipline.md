# Review Discipline: Dependencies, Change Sizing, Rationalisations

## Dependency Discipline

Before adding any dependency:

- Does the existing stack solve this? (Often it does.)
- How large is the dependency?
- Is it actively maintained?
- Does it have known vulnerabilities? (Check with the project's dependency audit tool, if applicable.)
- What is the license? Must be compatible with the project.

Prefer the standard library and existing utilities over new dependencies. Every dependency is a liability.

**Upgrading an existing dependency** is a code change like any other, and the riskiest upgrades are bulk
"bump deps" changes. Review them with the same discipline:

- **Read the changelog, not just the version number.** Semver is a promise the maintainer may not have
  kept — a "patch" can carry a behavioural change. For a major bump, read the migration notes and find what
  breaks.
- **One dependency per change** (or a small related group). When a bulk bump breaks the build, you lose which
  package did it; a single-package change makes the cause obvious and the revert clean.
- **Let the tests decide.** The upgrade is verified by a green check before _and_ after, not by "it
  installed." If coverage around the dependency's behaviour is thin, that gap is the real finding — add a
  test first.
- **Mind the transitive graph.** Review the lockfile diff, not just the dependency manifest; a single direct
  bump can pull in dozens of indirect changes.
- **Keep the lockfile honest.** Keep it in the change, review its diff, and never hand-edit it — the lockfile
  is what actually pins what ships.

## Change Sizing

Small, focused changes are easier to review, faster to evaluate, and safer to fold onto the sprint branch.

```
~100 lines changed   → Good. Reviewable in one sitting.
~300 lines changed   → Acceptable if it is a single logical change.
~1000 lines changed  → Too large.
```

**Watch file size, not just diff size.** A small diff can still push a file past a healthy boundary —
around 1 000 _total_ lines in a single file (distinct from the ~1 000 _changed_-lines threshold above) is a
common inspection signal, not a hard cap. The generator does not split or pre-extract. A file or diff past these sizes is a note for the planner. For the evaluator it is an observation.

**What counts as "one change":** A single self-contained modification that addresses one thing, includes
related tests, and keeps the system functional after submission.

**Separate refactoring from feature work.** A change that refactors existing code and adds new behaviour is
two changes. Small cleanups (variable renaming) can be included at reviewer discretion.

## Common Rationalisations

| Rationalisation                            | Reality                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "It works, that's good enough"             | Working code that is unreadable, insecure, or architecturally wrong creates debt that compounds.                                                                                |
| "I wrote it, so I know it is correct"      | Authors are blind to their own assumptions.                                                                                                                                     |
| "We will clean it up later"                | Later rarely comes. The review is the quality gate — use it.                                                                                                                    |
| "AI-generated code is probably fine"       | AI code needs more scrutiny, not less. It is confident and plausible, even when wrong.                                                                                          |
| "The tests pass, so it is good"            | Tests are necessary but not sufficient. They do not catch architecture problems, security issues, or readability concerns.                                                      |
| "The refactor makes it cleaner"            | Relocating complexity is not reducing it. If the reader still holds the same number of concepts, the structure did not improve — look for the version where branches disappear. |
| "It is only a small addition to this file" | Small diffs still push files past a healthy size and bolt branches onto unrelated flows. Judge the resulting structure, not the diff size.                                      |
| "It is just a version bump"                | A bump is a behaviour change you did not write. Read the changelog; semver does not guarantee no breakage.                                                                      |
| "Upgrade everything at once to save time"  | A bulk bump that breaks the build hides which package did it. One dependency per change keeps the cause and the revert clean.                                                   |
