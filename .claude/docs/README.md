# .claude/docs/

Living reference docs for ralphctl's architecture. Regenerate / re-read whenever
the shape of the chains or data models changes.

## Files

| File                                     | Purpose                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](./ARCHITECTURE.md)     | Five-module layout, ports, chain step orders, data models, file storage, error/exit tables                            |
| [REQUIREMENTS.md](./REQUIREMENTS.md)     | Acceptance-criteria checklists + the Ink TUI contract (view anatomy, keyboard, tokens, glyphs)                        |
| [KERNEL-DESIGN.md](./KERNEL-DESIGN.md)   | Chain framework reference — `Element` / `Leaf` / `Sequential` / `Parallel` / `Retry` / `OnError`                      |
| [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md)   | TUI design system — tokens, components, state surfaces, copy, anti-patterns. Read before building new views.          |
| [seq-refine.puml](./seq-refine.puml)     | _Legacy_ — sequence diagrams describe the legacy pipeline shape, not the new chain framework. Regenerate when needed. |
| [seq-plan.puml](./seq-plan.puml)         | _Legacy_ — see above                                                                                                  |
| [seq-ideate.puml](./seq-ideate.puml)     | _Legacy_ — see above                                                                                                  |
| [seq-evaluate.puml](./seq-evaluate.puml) | _Legacy_ — see above                                                                                                  |
| [seq-execute.puml](./seq-execute.puml)   | _Legacy_ — see above                                                                                                  |

The `seq-*.puml` diagrams describe the legacy pipeline shape and are pending regeneration against the kernel chain
framework. Until they are refreshed, `application/chains/<workflow>/<workflow>-flow.ts` (and its `.test.ts` step-order
fence) is the source of truth for each chain's step list.
