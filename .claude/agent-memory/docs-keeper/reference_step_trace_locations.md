---
name: step_trace_locations
description: The three places in the docs where every chain's step trace is documented — all three must be updated together
type: reference
---

Every chain's step trace appears in **three** places in the spec docs. All three must be updated together or the audit
will find drift:

1. **`REQUIREMENTS.md § Workflow chains > <Chain name>`** — the `- [ ] Step trace: ...` bullet under the chain's heading
2. **`ARCHITECTURE.md § Chain definitions` code block** — the `← outer: ...` comment on the right side of the file tree
   diagram
3. **`ARCHITECTURE.md § Chain definitions` table** — the `| Chain | Happy-path step trace |` table row

For Execute there is also a fourth location in `CLAUDE.md` — but as of 2026-05-02, CLAUDE.md contains step traces only
for `onboard` and `create-pr` flows (by name/reference, not full trace), so check with `grep` on each audit.

The canonical source of truth is always `tests/e2e/flows/<flow>.test.ts` — its `describe(...)` / `it(...)` titles and
asserted trace contain the exact step list.

**Gen-eval inner loop specifically** has its own step-order fence at
`tests/integration/application/flows/implement/leaves/gen-eval-loop.test.ts` (not a full e2e test). Two fences there:

- **gen-eval-turn children** (outer sequential): `[resolve-round-num, stamp-meta-generator, stamp-role-meta-generator, generator-<id>, evaluator-guard-<id>]`
- **evaluator-guard body** (inner sequential `evaluator-step-<id>`): `[stamp-meta-evaluator, stamp-role-meta-evaluator, evaluator-<id>, loop-diversity-check-<id>, entropy-check-<id>]`

All three doc locations must reflect this exact order. As of 2026-06-27: KERNEL-DESIGN.md code example and WORKFLOWS.md prose are updated; REQUIREMENTS.md plateau-predicate checkbox names the two new guard leaves.
