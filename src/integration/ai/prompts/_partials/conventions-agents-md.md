## AGENTS.md conventions

`AGENTS.md` is the cross-tool agent context file — recognised by OpenAI Codex and increasingly by other
agent runtimes. It is format-loose: no required heading schema, no hard line cap. Write it as clear
prose or bullets, organised into named sections, so any agent runtime that loads it can navigate it
without tool-specific knowledge.

**Structure rules:**

- Open with a brief one- or two-sentence project description (no formal H1 required, though a title
  heading is fine).
- Use H2 sections to group related rules — `## Build`, `## Testing`, `## Architecture`, etc.
- Keep sections short and scannable; avoid walls of prose. Bullets work well.
- No depth limit on headings, but rarely need more than `##`/`###`.
- No hard line cap, but keep the file under ~150 lines — longer files dilute the signal-to-noise
  ratio for models with a limited context window.

**Tone and framing:**

Write `AGENTS.md` as a plain, tool-agnostic specification. Avoid Claude-specific vocabulary
(`<tool>`, `slash commands`, hooks, `CLAUDE.md` cross-references) and Copilot-specific vocabulary
(Chat context, `@workspace`). The content should read equally well regardless of which agent runtime
is consuming it.

**Inclusion test** — include a rule only when an agent would get it wrong without being told. Skip
anything derivable from the language, the manifest, or the directory structure. Skip generic
engineering advice the model already follows by default.

**Sample stub** (adapt; do not copy verbatim):

```markdown
# Project Name

TypeScript monorepo. Use the workspace-aware install command; individual-package installs
break the shared lockfile.

## Build

- `<build command>` — compiles all packages to `dist/`.
- Environment: copy `.env.example` to `.env` and fill in required values before running.

## Testing

- `<test command>` — runs unit + integration tests.
- Integration tests require a running database; start it with `<database start command>`.
- Do not mock the database layer — use real fixtures from `tests/fixtures/`.

## Architecture

- <your layering rule> — e.g. which modules may import which, and which direction is forbidden.
- <your module-boundary rule> — e.g. no barrel re-export files; every import names its symbol explicitly.

## Conventions

- <your error-handling convention> — e.g. return a typed result instead of throwing for domain errors.
- <your I/O convention> — e.g. all writes go through one shared helper; direct filesystem calls
  are banned elsewhere.

## Security

- Do not log authentication tokens or request bodies, even at debug level.
- Never commit `.env` files — they contain real credentials for development services.
```
