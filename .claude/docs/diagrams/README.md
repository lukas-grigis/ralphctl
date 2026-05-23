# Architecture diagrams

Sequence and data-flow diagrams for the v0.7.x architecture. GitHub renders Mermaid natively
in markdown previews — no toolchain required.

| #   | Diagram                                              | What it shows                                                                            |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 00  | [Chain framework](./00-chain-framework.md)           | One chain run end to end: runner → session → element → event bus.                        |
| 01  | [Flow lifecycle](./01-flow-lifecycle.md)             | From a TUI click / CLI subcommand to a running chain.                                    |
| 02  | [Sprint lifecycle](./02-sprint-lifecycle.md)         | One sprint's user-action timeline: create → plan → implement → review → close.           |
| 03  | [Task lifecycle](./03-task-lifecycle.md)             | One task's per-attempt timeline: preflight → generator-evaluator loop → verify → commit. |
| 04  | [AI session data flow](./04-ai-session-data-flow.md) | The audit-[09] file-based contract: prompt in, `signals.json` out, sidecars rendered.    |

## Conventions

- **Sequence diagrams are the default shape** — they show what happens, in order. State
  machines, class diagrams, and nested flowcharts ask the reader to translate; sequence
  diagrams just narrate.
- One diagram per file. If two diagrams want to share a page, split the page.
- Plain Mermaid syntax only — no custom themes, no class definitions, no nested subgraphs.
  Anything fancier is a sign the diagram is doing too much.
- Each file links back to the code path that backs the picture.

## What's deliberately not diagrammed

- **Module layout** — `domain → business → integration → application` is one English sentence
  in `CLAUDE.md`. A box-and-arrow diagram would be filler.
- **`Element` / `Leaf` / `Sequential` / `Loop` / `Guard` class hierarchy** — the prose list
  in `KERNEL-DESIGN.md` communicates the typed contract more precisely than a class diagram.
- **Flow inventory table** — lives in `ARCHITECTURE.md` § Flow registry and in the live
  `src/application/registry.ts`. Duplicating here would invite drift.

## When to update

When a flow's element graph changes, a state transition is added or removed, or a new chain
primitive ships — update the matching diagram in the same commit. Step-order fence tests
under `tests/integration/flows/<flow>/` lock the code side; these diagrams lock the
human-readable understanding.

## Rendering outside GitHub

To export a diagram to SVG (for slides or external docs):

```bash
npx -p @mermaid-js/mermaid-cli mmdc -i input.mmd -o output.svg
```
