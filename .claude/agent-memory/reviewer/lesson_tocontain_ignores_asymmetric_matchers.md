---
name: tocontain-ignores-asymmetric-matchers
description: not.toContain(expect.stringContaining(..)) is a permanent pass
metadata:
  type: feedback
---

Vitest's `toContain` does not honour asymmetric matchers, so `expect(arr).not.toContain(expect.stringContaining('x'))`
always passes. Grep new tests for it; the working form is `arr.filter(s => s.includes('x')).toHaveLength(0)`.
