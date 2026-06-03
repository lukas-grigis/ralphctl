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
