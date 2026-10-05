---
name: wrapper-in-template-vs-renderer
description: A tag the template already wraps around a placeholder must not also be emitted by the renderer
metadata:
  type: feedback
---

When the template writes `<tag>{{KEY}}</tag>` (prior_critique, restored_work), the renderer for KEY returns a bare body — not `renderTaggedBlock`, which emits its own wrapper and would nest the tag twice. Use `renderTaggedBlock` only when the template has a bare `{{KEY}}` line.

**Why:** the two styles coexist in implement/template.md and look identical at the call site.
**How to apply:** check how the placeholder sits in the template before choosing the renderer; the absent case then renders an empty wrapper, so tests assert `<tag></tag>`.
