---
name: agent_files_also_drift
description: .claude/agents/*.md files contain kernel/chain references and drift when primitives change — check them alongside the five spec docs
type: feedback
---

Agent files under `.claude/agents/` (implementer, reviewer, planner, docs-keeper) repeat kernel primitive lists
and must be updated when a primitive is added or removed.

**Why:** When `Parallel` was removed in feature/enhance, the implementer.md, reviewer.md, planner.md, and
docs-keeper.md all still listed six kernel concepts. The `.claude/docs/README.md` description row also drifted.

**How to apply:** When auditing for kernel-primitive changes, add these files to the grep: `.claude/agents/*.md`
and `.claude/docs/README.md`. A single grep for `Element.*Leaf.*Sequential.*Parallel` or `six concepts` catches
all instances.
