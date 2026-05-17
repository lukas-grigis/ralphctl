# .claude/docs/

Living reference docs for ralphctl's architecture. Regenerate / re-read whenever the shape of the chains or
data models changes.

## Files

| File                                                 | Purpose                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [ARCHITECTURE.md](./ARCHITECTURE.md)                 | Four-module layout, ports, chain step orders, data models, file storage, error/exit tables                   |
| [REQUIREMENTS.md](./REQUIREMENTS.md)                 | Acceptance-criteria checklist + the Ink TUI contract                                                         |
| [KERNEL-DESIGN.md](./KERNEL-DESIGN.md)               | Chain framework reference — `element` / `leaf` / `sequential` / `loop` / `guard` (factory functions)         |
| [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md)               | TUI design system — tokens, components, state surfaces, copy, anti-patterns. Read before building new views. |
| [MANUAL-TEST-PLAYBOOK.md](./MANUAL-TEST-PLAYBOOK.md) | Manual smoke-test script. Read before cutting a release.                                                     |
| [diagrams/](./diagrams/README.md)                    | Mermaid diagrams: module layout, chain framework, flow lifecycle, sprint / task state machines.              |

The filename `KERNEL-DESIGN.md` is preserved from v0.6.x for cross-reference continuity — v0.7.0 has no
`kernel/` module; the chain primitives live inside `application/`.

## Loading

**No doc under `.claude/docs/` is auto-imported.** `CLAUDE.md` is the only file loaded into every Claude
Code session; the docs here are reference material loaded on demand via the `Read` tool when an agent needs
detail beyond what `CLAUDE.md` carries.

| File                    | Load when…                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------- |
| ARCHITECTURE.md         | Working on layout / ports / repositories / data models / error tables / storage paths   |
| KERNEL-DESIGN.md        | Working on the chain framework primitives or writing a new flow / leaf                  |
| REQUIREMENTS.md         | Ticking off acceptance criteria, auditing a release, or surfacing the verification gate |
| DESIGN-SYSTEM.md        | Building or editing any TUI view / component                                            |
| MANUAL-TEST-PLAYBOOK.md | Cutting a release — walk through the playbook in a real terminal before tagging         |

**Why no auto-imports?** Empirical findings on context files (arXiv 2511.12884, 2509.14744) recommend ≤300
lines and ≤7 H2 sections for the file an agent loads on every session. `CLAUDE.md` lives within those
limits. Auto-importing every reference doc would inflate the baseline budget by ~1 kLoC for content most
sessions never touch.

`src/application/flows/<flow>/flow.ts` (and its `.test.ts` step-order fence) is the source of truth for each
flow's step list. `src/application/registry.ts` is the source of truth for "what flows exist."
