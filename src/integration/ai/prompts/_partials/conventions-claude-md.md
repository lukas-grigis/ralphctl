## CLAUDE.md conventions

`CLAUDE.md` is Claude Code's native project context file — loaded automatically from the repository root
at the start of every session. Write it as a compact reference document an agent re-reads on every
invocation, not as a tutorial or README.

**Structure rules:**

- Open with a one-line project description; a `# Project Name` title is fine.
- Group rules under a few `##` sections (`## Build & Run`, `## Testing`, …) with tight bullets; each bullet
  is one verifiable claim.
- Target under 200 lines — adherence drops as the file grows, so brevity is load-bearing. With an existing
  file, add sections only.

**"Read on demand" pattern** — for sections that an agent rarely needs mid-task, list them under a
`## References` heading with paths rather than embedding the content inline:

```
## References

- `docs/architecture.md` — module layout and layering rules
- `docs/style-guide.md` — UI style guide and component copy rules
```

This keeps the primary file short while keeping the information reachable.

**Inclusion test** — include a rule only when an agent would get it wrong without being told. Skip
language conventions the model already knows. Skip anything derivable from directory structure or
manifest files.

**Sample stub** (adapt; do not copy verbatim):

```markdown
# Project Name

<language and runtime> service. Run `<install command>` once, then `<dev command>` to start.

## Build & Run

- `<build command>` — writes artefacts to `<output dir>`.
- Required env: `<VAR_NAME>` (<what it holds>).

## Testing

- `<test command>` — runs everything. `<single-test command>` runs one file.
- <a prerequisite or quirk of the test run that is easy to miss>.

## Architecture

- <your layering rule> — which modules may import which, and which direction is forbidden.

## Conventions

- <your naming or formatting rule> — state it as a checkable rule, not general advice.
```
