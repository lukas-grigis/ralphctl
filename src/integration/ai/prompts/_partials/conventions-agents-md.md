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
- Target under ~150 lines — longer files dilute the signal-to-noise ratio for models with a limited
  context window.

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

<language> monorepo. Use the workspace-aware install command; individual-package installs
break the shared lockfile.

## Build

- `<build command>` — builds all packages.
- Environment: copy `.env.example` to `.env` and fill in required values before running.

## Testing

- `<test command>` — runs unit and integration tests.
- Integration tests need `<service>` running; start it with `<start command>`.

## Conventions

- <a rule that differs from the language's defaults> — state it as a checkable rule.
- Generated files under `<dir>` are never edited by hand; regenerate with `<command>`.
```
