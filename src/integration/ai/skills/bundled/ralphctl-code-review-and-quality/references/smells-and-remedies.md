# Structural Remedies and Smell Baseline

## Structural Remedies

When you flag a structural problem, propose the move — not just the problem. A finding that only says "this
is complex" leaves the generator or author guessing. Reach for a named restructuring:

- **Replace a chain of conditionals** with a typed model or an explicit dispatcher.
- **Collapse duplicate branches** into a single clearer flow.
- **Separate orchestration from business logic** so each reads on its own.
- **Move feature-specific logic** out of a shared module into the module that owns the concept.
- **Reuse the canonical helper** instead of a bespoke near-duplicate.
- **Make a type boundary explicit** so downstream branching disappears.
- **Delete a pass-through wrapper** that adds indirection without clarifying the API.
- **Extract a helper, or split a large file** into focused modules.

Prefer the remedy that removes moving pieces over one that spreads the same complexity around.

## Smell Baseline

On top of whatever the project documents, a fixed set of code smells (Fowler, _Refactoring_) applies even
where a repository documents nothing. Each is a labelled judgement call ("possible Feature Envy") at Minor or
Nit, never a hard violation. A documented project standard that endorses the pattern overrides the smell, and
anything tooling already enforces is skipped.

- **Mysterious Name** — the name does not say what it does or holds → rename; no honest name means murky design.
- **Duplicated Code** — the same logic shape in several hunks or files → extract it once.
- **Feature Envy** — a function that works on another module's data more than its own → move it there.
- **Data Clumps** — the same few values always travel together → give them one type.
- **Primitive Obsession** — a string or number standing in for a domain concept → give the concept a type.
- **Repeated Switches** — the same branching on the same type in several places → one dispatch both share.
- **Shotgun Surgery** — one logical change forces scattered edits → gather what changes together.
- **Divergent Change** — one module edited for several unrelated reasons → split by reason.
- **Speculative Generality** — hooks, parameters, or abstractions for needs nobody has → delete them.
- **Message Chains** — callers walking a long chain of navigation → hide the walk behind one call.
- **Middle Man** — a layer that mostly delegates → call the real target directly.
- **Refused Bequest** — an implementer ignoring most of what it inherits → compose instead of inheriting.
