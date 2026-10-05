## .github/copilot-instructions.md conventions

`.github/copilot-instructions.md` is GitHub Copilot's native project context file — injected into every
Copilot Chat and Copilot Coding Agent session. Write it as a set of **decision-rationale pairs**: each
rule states what to do and, on the same line or the next bullet, _why_ — because Copilot performs better
when it understands the motivation behind a constraint, not just the constraint itself.

**Structure rules:**

- No required heading schema — free prose and bullets both work. H2 sections help scanability.
- Lead every non-obvious rule with a "what + why" pair. Example: "Never mock the database layer
  in integration tests — prior incidents show mock/prod divergence masks real migration failures."
- Keep it short; Copilot context injection has a token budget.
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

- <your layering rule> — <why it exists>. State the enforcement mechanism (linter, review
  checklist) so the model knows a violation is checkable.

## Testing

- <a testing rule> — <the incident or constraint behind it>.

## Conventions

- <a convention that differs from defaults> — <the reason a reviewer would otherwise push back>.

## Security

- <what must never be logged, committed or called> — <what goes wrong if it is>.
```
