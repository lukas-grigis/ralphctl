---
name: reference-agent-files-also-drift
description: The 7 .claude/agents/*.md files and .claude/docs/README.md repeat kernel-primitive lists and drift when a primitive changes — grep them alongside the spec docs
metadata:
  type: reference
---

`.claude/agents/*.md` (designer, docs-keeper, implementer, planner, prompt-template-engineer, reviewer,
tester) restate kernel primitive lists, and `.claude/docs/README.md`'s description rows restate what each
doc covers. Both rot when a primitive is added or removed — when `Parallel` was dropped, every agent file
still listed six kernel concepts.

**How to apply:** on any kernel-primitive audit, add `.claude/agents/*.md` and `.claude/docs/README.md`
to the grep set. A single grep for the primitive names together (or for a stated concept count) catches
every instance at once.
