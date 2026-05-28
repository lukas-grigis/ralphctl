## .github/copilot-instructions.md conventions

`.github/copilot-instructions.md` is GitHub Copilot's native project context file — injected into every
Copilot Chat and Copilot Coding Agent session. Write it as a set of **decision-rationale pairs**: each
rule states what to do and, on the same line or the next bullet, _why_ — because Copilot performs better
when it understands the motivation behind a constraint, not just the constraint itself.

**Structure rules:**

- No required heading schema — free prose and bullets both work. H2 sections help scanability.
- Lead every non-obvious rule with a "what + why" pair. Example: "Never mock the database layer
  in integration tests — prior incidents show mock/prod divergence masks real migration failures."
- Keep the file under 100–150 lines; Copilot context injection has a token budget.
- Prefer present-tense imperatives: "Use X", "Do not Y", "Prefer Z over W".
- Reference file paths with backticks so Copilot can navigate to them.

**Tone and framing:**

Copilot instructions read best when they frame constraints as informed decisions rather than
arbitrary mandates. Where a rule exists because of a past incident, a performance requirement, or a
security boundary, name it — this helps the model distinguish "this rule is load-bearing" from "this is
a style preference."

**Inclusion test** — include a rule only when an agent would get it wrong without being told. Skip
anything derivable from the language, the manifest, or the directory structure. Skip generic engineering
advice the model already follows by default.

**Sample stub** (adapt; do not copy verbatim):

```markdown
## Architecture

- Four-module Clean Architecture: `domain → business → integration → application` — inner layers
  must not import outer ones. ESLint enforces this; a lint failure means a layering violation.
- No barrel `index.ts` files — every import names what it pulls in. This keeps dead-code analysis
  accurate; barrel files silently re-export unused symbols.

## Testing

- Integration tests hit a real database, not a mock — the team has been burned by mock/prod
  divergence masking broken migrations. Use the test fixtures in `tests/fixtures/` to seed state.

## Conventions

- Every business operation returns `Result<T, DomainError>` — do not throw. Throws are reserved for
  programmer errors (invariant violations inside leaf projections).
- Em-dash (`—`) for explanatory clauses in comments and documentation — not a hyphen.

## Security

- Never log request bodies or auth tokens — even at debug level. The logger is structured and ships
  to a third-party aggregator; sensitive fields would be retained.
```
