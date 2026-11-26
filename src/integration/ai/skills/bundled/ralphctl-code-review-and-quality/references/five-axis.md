# The Five-Axis Review in detail

Detail for each axis summarised in SKILL.md.

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
- **Is a new conditional bolted onto an unrelated flow?** That is a design smell, not a nit — push the logic
  into its own helper, state, or policy instead of tangling an existing path.
- **Do repeated conditionals on the same shape appear?** They signal a missing model or dispatcher. A
  "temporary" branch is usually permanent debt.

### 3. Architecture

Does the change fit the system's design?

- Does it follow existing patterns, or introduce a new one? If new, is it justified?
- Does it maintain clean module boundaries?
- Is there code duplication that should be shared?
- Are dependencies flowing in the right direction — no circular dependencies?
- Is the abstraction level appropriate — not over-engineered, not too coupled?
- **Does this refactor reduce complexity or just relocate it?** Count the concepts a reader must hold to
  follow the change. If a "cleaner" version leaves that count unchanged, it is not cleaner — prefer the
  restructuring that makes whole branches, modes, or layers disappear over one that re-centralises the same
  logic. Prefer deleting an abstraction to polishing it.
- **Is feature-specific logic leaking into a shared or general-purpose module?** Keep logic in its owning
  layer, reuse the existing canonical helper instead of a near-duplicate, and do not normalise architectural
  drift.
- **Are type boundaries explicit?** Question gratuitous untyped escape hatches, optional fields, casts, and
  silent fallbacks that paper over an unclear invariant — making the boundary explicit often makes the
  surrounding control flow simpler.

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

Judge scale against the expected load, found in the repository (README, deploy configuration): a script one
person runs is not a service under concurrent traffic. Check-then-write races, work every process repeats,
collections that only grow, and per-process state that must be shared are findings at the load that
triggers them — say which load you assumed.
