---
name: flow-trace-sync
description: Check the chain-flow step-traces documented in `.claude/docs/` (KERNEL-DESIGN.md examples, the `diagrams/`, REQUIREMENTS step lists) against the REAL element-name sequence each flow runs, and fix the drift. Use this after changing a flow's element list (adding/removing/reordering a `leaf`/`sequential`/`guard`/`loop`, renaming an element), before a release, or whenever a documented "this flow runs A → B → C" sequence feels stale. Flow definitions and their step-order fence tests are the source of truth; the prose traces in docs paraphrase them and rot silently. This is the step-order counterpart to `drift-sweep` (which handles path/version/symbol drift).
when_to_use: Trigger on "the flow trace is stale", "update the step-order docs", "did the diagram/KERNEL-DESIGN flow change", after editing any `src/application/flows/<flow>/` element list, or when a documented chain sequence is suspected wrong. Not for code correctness (the fence tests cover that) — this syncs the human-facing traces to the code.
allowed-tools: Bash, Read, Grep, Edit
---

# Flow Trace Sync

A ralphctl flow is a tree of named chain elements (`sequential('implement', […])`, `guard('task-runnable-<id>',
…)`, `loop('task-attempts-<id>', …)`). The order and names of those elements are the flow's observable shape —
and several docs describe it in prose or diagrams: the `implementFlow` example in `KERNEL-DESIGN.md`, the
sequence diagrams under `.claude/docs/diagrams/`, and the step-by-step criteria in `REQUIREMENTS.md`.

The code owns that shape in two places: the flow **definition** (the `leaf/sequential/guard/loop('<name>')`
calls) and the **step-order fence test** (which asserts `trace.map(s => s.elementName)` for happy + failure
paths — a test fails the moment the real order changes). The docs do not fail when they fall behind. So a
`guard` gets added, an element gets renamed, the loop nesting changes — the test is updated, the prose is not,
and the next reader trusts a sequence the harness no longer runs. This skill closes that gap.

## When this earns its keep

- Right after you change a flow's element list — add/remove/reorder/rename a `leaf`/`sequential`/`guard`/`loop`.
- Before a release, alongside `drift-sweep`, so the architecture docs ship accurate.
- When a documented "A → B → C" trace looks wrong against the code.

## How to run it

1. **Extract the real element sequences:**

   ```bash
   bash .claude/skills/flow-trace-sync/scripts/flow-traces.sh           # all flows
   bash .claude/skills/flow-trace-sync/scripts/flow-traces.sh implement # one flow
   ```

   For each flow it lists the element names found in the definition (deduped, file order) and points at the
   fence test that asserts the canonical runtime sequence. Note: the listed order is _definition_ order across
   files, not the exact runtime order — the **fence test is authoritative** for the precise sequence, so open
   it when order matters.

2. **Locate the documented traces** that describe the changed flow:
   - `KERNEL-DESIGN.md` — worked flow examples (e.g. `implementFlow`).
   - `.claude/docs/diagrams/` — the sequence / lifecycle diagrams.
   - `REQUIREMENTS.md` — criteria that spell out an attempt/loop body order.

3. **Diff and fix.** Compare each documented trace to the real elements + the fence test. Two outcomes:
   - **Drift** — a wrong order, a renamed element, a dropped/added step the doc still omits/keeps. Fix the doc
     to match the code.
   - **Deliberate simplification** — a doc may intentionally show a reduced sketch (the `implementFlow`
     example, for instance, omits the dependency-gate `guard` and the restore/quarantine leaves). That is fine
     **only if it says so** — label it "simplified — see `<flow file>` for the full topology". An unlabelled
     simplification reads as a false claim; a labelled one is honest.

## What counts as real drift

- An element **name** in the docs that no longer exists in the flow (grep it in `src/application/flows/<flow>/`).
- An **order** in the docs that contradicts the fence test's `elementName` sequence.
- A **structural** change — a new `guard`/`loop` layer, a removed stage — that the prose/diagram predates.

A name that the docs simplify or alias is not drift _if labelled_; an outright wrong or stale one is.

## Relationship to `drift-sweep` and `verify`

`verify` runs the fence tests — it guarantees the _code's_ trace is internally consistent. `drift-sweep` finds
stale paths/versions/symbols across `.claude/`. `flow-trace-sync` is the narrow, deeper check the other two
miss: do the human-facing step-order narratives still match the flows? Run it whenever a flow's shape moves.
