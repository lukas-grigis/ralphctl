# Architecture diagrams

Mermaid diagrams for the four v0.7.0 concepts where a picture is meaningfully clearer than
prose — state machines and multi-step indirection. GitHub renders Mermaid natively in
markdown previews; no toolchain required.

| #   | Diagram                                      | What it shows                                                                                                                                                     |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 00  | [Chain framework](./00-chain-framework.md)   | Runner status machine (`idle → running → completed / failed / aborted`) and a real composition example (the implement flow's per-task gen-eval body).             |
| 01  | [Flow lifecycle](./01-flow-lifecycle.md)     | How a flow goes from `FlowManifest` in `registry.ts` through a factory and the runner to EventBus fan-out. Multi-step indirection that prose has to walk through. |
| 02  | [Sprint lifecycle](./02-sprint-lifecycle.md) | Sprint state machine (`draft → active → review → done`), operation matrix, and the three-file on-disk shape.                                                      |
| 03  | [Task lifecycle](./03-task-lifecycle.md)     | Task state machine (`todo / in_progress / done / blocked`) plus the per-task gen-eval loop body with iteration budgets and outcome branches.                      |

## What's deliberately NOT diagrammed

- **Module layout** — `domain → business → integration → application` is one English sentence
  in CLAUDE.md. A box-and-arrow diagram would be filler.
- **Element / Leaf / Sequential / Loop / Guard class hierarchy** — the prose list in
  KERNEL-DESIGN.md communicates the typed contract more precisely than a class diagram.
- **Flow inventory table** — lives in ARCHITECTURE.md § Flow registry (where it belongs) and
  in the live `src/application/registry.ts`. Duplicating it here would invite drift.
- **`FlowTriggers` predicate list** — a struct, not a graph.
- **EventBus fan-out / AI provider contract** — covered in prose under CLAUDE.md § Architecture
  and § Security & Safety. Worth a sequence diagram if a contributor needs one; deferred until
  the request is concrete.

## When to update

When a flow's element graph changes, a state transition is added or removed, or a new chain
primitive ships — update the matching diagram in the same commit. Step-order fence tests
under `tests/integration/flows/<flow>/` lock the code side; these diagrams lock the
human-readable understanding.

## Rendering outside GitHub

To export to SVG (for slides / external docs):

```bash
npx -p @mermaid-js/mermaid-cli mmdc -i input.mmd -o output.svg
```

## Why Mermaid (not PlantUML)

The v2 source repo (`/Users/grigis/Workzone/github/lukas-grigis/ralphctl-v2/docs/`) shipped
with PlantUML activity diagrams under `docs/architecture/diagrams/` and `docs/domain/`. Those
files describe a chain framework that included `Retry` + `OnError` decorators and a sentinel
`isRetryNeededError` — concepts that **did not make the final v0.7.0 codebase**. v0.7.0 ships
only `element / leaf / sequential / loop / guard`; retry happens at the adapter level in
`rate-limit-backoff.ts`. The diagrams here describe what the code actually does today.
