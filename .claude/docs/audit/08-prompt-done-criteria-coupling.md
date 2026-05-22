# 08 — Prompt template ↔ done-criteria coupling

**Status:** decided-keep (2026-05-22)
**Related:
** [05 done-criteria separation](05-done-criteria-separation.md), [11 prompt unit tests](11-prompt-template-unit-tests.md)

## Where the criteria live after [05](05-done-criteria-separation.md)

`Task.verificationCriteria` is the canonical source. It's rendered into the prompt at two sites:

- `src/integration/ai/prompts/implement/template.md` (generator) via `{{VERIFICATION_CRITERIA_SECTION}}`
- `src/integration/ai/prompts/evaluate/template.md` (evaluator) via the same placeholder

Both substitution sites call `renderVerificationCriteriaSection(task)`. The rendered text lands in each spawn's
`prompt.md` on disk — that file is the per-round audit of what the AI was held to.

So per round, the criteria appear in **two** places:

| #   | Where                                         | Form                     | Role                                      |
| --- | --------------------------------------------- | ------------------------ | ----------------------------------------- |
| 1   | `Task.verificationCriteria` (`tasks.json`)    | string array             | canonical source                          |
| 2   | Per-spawn `prompt.md` (generator + evaluator) | inlined markdown bullets | target — what the AI sees + on-disk audit |

The TUI also renders from `Task.verificationCriteria` directly (in-memory, synchronous, no file read). That's a third
_render_ but not a third _persisted copy_.

## Decision: keep inlining, no further reduction

The two-places shape is the right floor. Going lower means having the prompt
reference an external file ("see `done-criteria.md`"), which we already
rejected:

- Two cognitive hops for the AI. Inlining keeps the criteria in the prompt's context window from turn 1, every turn.
- Short bullet lists belong inline, not behind a file pointer.
- Refine / plan / ideate don't have criteria; this is implement + evaluate-only. Adding a cross-file convention for one
  signal isn't worth it.

The duplication cost is one render-helper call per template. The renderer
(`renderVerificationCriteriaSection`) is the single source of truth for the
markdown shape.

## What [11](11-prompt-template-unit-tests.md) enforces

The prompt-template unit tests verify that:

- `{{VERIFICATION_CRITERIA_SECTION}}` appears in both `implement/template.md` and `evaluate/template.md`.
- The parameter schema for each template declares the field that drives the renderer.
- A fully-populated parameter set rendered through the template leaves no unsubstituted placeholders.

That's the fence against accidental drift — change the renderer, the tests prove the templates still substitute
correctly.

## Action items

- [ ] Add a one-line comment to `renderVerificationCriteriaSection` noting it's the single source of truth for the
      criteria markdown shape, used by both implement and evaluate templates.
- [ ] Confirm `{{VERIFICATION_CRITERIA_SECTION}}` renders under a stable `## Done criteria` heading so operators can
      `grep` the heading in `prompt.md`.
- [ ] Make sure [11](11-prompt-template-unit-tests.md)'s test grid covers both templates exercising the placeholder.

## Why [05](05-done-criteria-separation.md) closed the third place

Pre-[05], the criteria also lived in a standalone `done-criteria.md` per task.
That file was deleted because:

- The TUI was the only direct reader and can render from in-memory state.
- The audit role is covered by per-round `prompt.md` (which contains the inlined criteria block).
- "What's currently on disk" was a confusing question with three answers; now it's one (`prompt.md`).

See [05](05-done-criteria-separation.md) for the full reasoning.
