## CLAUDE.md conventions

`CLAUDE.md` is Claude Code's native project context file — loaded automatically from the repository root
at the start of every session. Write it as a compact reference document an agent re-reads on every
invocation, not as a tutorial or README.

**Structure rules:**

- Exactly one H1 (`# Project Name`) as the opening line.
- At most seven H2 sections (`## Build & Run`, `## Testing`, `## Architecture`, …). Fewer is better.
- No H4 headings or deeper — three heading levels (`#`, `##`, `###`) is the practical maximum.
- Prefer tight bullet lists over prose paragraphs; each bullet should be one verifiable claim.
- Hard line cap: 200 lines. Claude Code truncates longer files, so brevity is load-bearing.

**"Read on demand" pattern** — for sections that an agent rarely needs mid-task, list them under a
`## References` heading with paths rather than embedding the content inline:

```
## References

- `.claude/docs/ARCHITECTURE.md` — module layout and layering rules
- `.claude/docs/DESIGN-SYSTEM.md` — TUI tokens and component copy rules
```

This keeps the primary file short while keeping the information reachable.

**Inclusion test** — include a rule only when an agent would get it wrong without being told. Skip
language conventions the model already knows. Skip anything derivable from directory structure or
manifest files.

**Sample stub** (adapt; do not copy verbatim):

```markdown
# Project Name

Node.js 20 + TypeScript. Run `<install command>` once, then `<dev command>` to start.

## Build & Run

- `<build command>` — compiles to `dist/`.
- Required env: `DATABASE_URL` (Postgres connection string).

## Testing

- `<test command>` — unit + integration. Integration tests require a running database.
- Do not mock the database layer — prior incidents show mock/prod divergence is a real risk.

## Architecture

- Four-module Clean Architecture: `domain → business → integration → application`.
- No barrel `index.ts` files under `src/` — name every import explicitly.
- Business code must not import I/O-bearing `node:*` modules — pure `node:path` / `node:url` ok.

## Conventions

- Return `Result<T, DomainError>` from every business operation — do not throw.
- Em-dash (`—`) for explanatory clauses in comments and docs.
```
