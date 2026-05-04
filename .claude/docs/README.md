# .claude/docs/

Living reference docs for ralphctl's architecture. Regenerate / re-read whenever
the shape of the chains or data models changes.

## Files

| File                                                 | Purpose                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [ARCHITECTURE.md](./ARCHITECTURE.md)                 | Five-module layout, ports, chain step orders, data models, file storage, error/exit tables                   |
| [REQUIREMENTS.md](./REQUIREMENTS.md)                 | Acceptance-criteria checklists + the Ink TUI contract (view anatomy, keyboard, tokens, glyphs)               |
| [KERNEL-DESIGN.md](./KERNEL-DESIGN.md)               | Chain framework reference — `Element` / `Leaf` / `Sequential` / `Retry` / `OnError` (five concepts)          |
| [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md)               | TUI design system — tokens, components, state surfaces, copy, anti-patterns. Read before building new views. |
| [MANUAL-TEST-PLAYBOOK.md](./MANUAL-TEST-PLAYBOOK.md) | Manual smoke-test script. Read before cutting a release.                                                     |

## Loading

`CLAUDE.md` at the repo root pulls a subset of these docs into every Claude session via `@` imports. The rest are
loaded on demand by Claude (`Read` tool) or by an agent that explicitly needs them.

| File                    | Auto-imported into every session? | Notes                                                                      |
| ----------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| ARCHITECTURE.md         | Yes                               | Data models, ports, signals, error / exit tables — needed in every session |
| KERNEL-DESIGN.md        | Yes                               | Lean (~8k chars); chain framework reference                                |
| REQUIREMENTS.md         | **No**                            | Read on demand (release audits, ticking criteria, docs-keeper / reviewer)  |
| DESIGN-SYSTEM.md        | No                                | Designer agent loads automatically; load before any TUI / Ink work         |
| MANUAL-TEST-PLAYBOOK.md | No                                | Load before release smoke-tests                                            |

> **Why the split?** Auto-imported context is paid for in every session's token budget. REQUIREMENTS.md is a
> testable acceptance-criteria checklist — useful when ticking off requirements or auditing a release, but agents
> doing day-to-day implementation work don't act on checkboxes. They act on the narrative constraints in CLAUDE.md
> and ARCHITECTURE.md. Splitting keeps baseline context lean without losing the verification surface.

`application/chains/<workflow>/<workflow>-flow.ts` (and its `.test.ts` step-order fence) is the source of truth for
each chain's step list.
