# Architecture diagrams

Mermaid diagrams covering the v0.7.0 architecture. Each file pairs a diagram with a
paragraph of context so it works as a standalone reference. GitHub renders Mermaid natively
in markdown previews — no toolchain required.

| #   | Diagram                                      | What it shows                                                                                                                                                                       |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 00  | [Module layout](./00-module-layout.md)       | Four-layer Clean Architecture (domain → business → integration → application) + sibling-isolation rules under `integration/ai/<concept>/`.                                          |
| 01  | [Chain framework](./01-chain-framework.md)   | The five chain primitives (`element` / `leaf` / `sequential` / `loop` / `guard`) and the runner status / event-stream lifecycle.                                                    |
| 02  | [Flow lifecycle](./02-flow-lifecycle.md)     | How a flow goes from `FlowManifest` in `registry.ts` through a factory and the runner to EventBus events. Includes the trigger predicates and the deliberately-smaller CLI surface. |
| 03  | [Sprint lifecycle](./03-sprint-lifecycle.md) | Sprint state machine (`draft → active → review → done`), operation matrix, and the three-file on-disk shape.                                                                        |
| 04  | [Task lifecycle](./04-task-lifecycle.md)     | Task state machine (`todo / in_progress / done / blocked`) plus the per-task gen-eval loop body.                                                                                    |

## When to update

When a flow's element graph changes, when a state transition is added or removed, or when a
new chain primitive ships — update the matching diagram in the same commit as the code.
Step-order fence tests (in `tests/integration/flows/<flow>/`) lock the code side; these
diagrams lock the human-readable understanding.

The `docs-keeper` agent watches for drift; its audit workflow includes the diagrams.

## Rendering

Mermaid renders inside any markdown viewer that supports it: GitHub, VS Code (with the
built-in markdown preview), Obsidian, most JetBrains IDEs, and `mdx`-based static-site
generators. No `plantuml` CLI or Java required.

To render outside markdown (e.g. for a slide deck or a SVG asset), pipe a Mermaid block
through the `mmdc` CLI (`@mermaid-js/mermaid-cli`):

```bash
npx -p @mermaid-js/mermaid-cli mmdc -i input.mmd -o output.svg
```

## Why Mermaid (not PlantUML)

The v2 source repo (`/Users/grigis/Workzone/github/lukas-grigis/ralphctl-v2/docs/`) shipped
with PlantUML activity diagrams under `docs/architecture/diagrams/` and `docs/domain/`.
Those files describe a chain framework that included `Retry` + `OnError` decorators and a
sentinel `isRetryNeededError` — concepts that **did not make the final v0.7.0 codebase**.
The v2 codebase implements only `element / leaf / sequential / loop / guard`; retry happens
at the adapter level (`rate-limit-backoff.ts`), not as a framework primitive. The diagrams
here describe what the code actually does today, written fresh against v0.7.0 reality.
