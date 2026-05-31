---
name: session.md audit pack written by adapter, not chain leaves
description: Where the per-spawn `session.md` audit file is created and why the writer lives in `ProviderAiSessionAdapter`
type: project
---

The per-spawn `session.md` audit file (frontmatter: provider/model/cwd/flags + `## Prompt` body) is written by
`ProviderAiSessionAdapter`, NOT by chain leaves. Triggered by `SessionOptions.sessionMdPath`.

**Why:** The adapter has all the data — provider name, computed flag list, cwd, prompt, model + sessionId after spawn,
exit code. Threading that up to chain leaves would cross the layering for no gain. Per-unit folder layout was the user's
#1 visibility goal.

**How to apply:** When adding a new AI-spawn surface, derive the right `session.md` path in the chain leaf (use
`nextSessionPath` from `src/integration/persistence/session-md-writer.ts` for round-rotated paths, plain
`<root>/session.md` for one-shot phases) and pass it via `SessionOptions.sessionMdPath`. The adapter's writes are
best-effort and never fail the spawn — `LoggerPort` is wired through `ProviderAiSessionAdapterOptions.logger` for
warn-level audit failures. The model is captured via a post-spawn surgical patch (`upsertFrontmatterField`) since it
isn't known until after the spawn settles.

Per-flow path conventions (locked in chain leaves):

- refine: `<refinementUnitRoot>/session.md` (single, overwritten)
- plan: `<planningFolderRoot>/session.md` (single, overwritten)
- per-task execute & evaluator: `<executionUnitRoot>/session-N.md` (rotated via `nextSessionPath`)
- standalone evaluate: `<sprintDir>/evaluations/session-<task-id>.md`
- feedback: `<sprintDir>/feedback/session-<iteration>.md`
- ideate: NOT wired (no build leaf in the chain today)
