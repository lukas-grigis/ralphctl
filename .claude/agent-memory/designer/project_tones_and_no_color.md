---
name: project-tones-and-no-color
description: Tones token, one ListCard row, NO_COLOR/FORCE_COLOR launch order, and the chalk-level test trick
metadata:
  type: project
---

Colour per meaning lives only in `tones` (tokens.ts); components map their own enums to a `Tone`, never to hex.

- `src/index.ts` must set `FORCE_COLOR=0` BEFORE the CLI graph (chalk fixes its level at first import), so the predicate is loaded by dynamic import after `NODE_ENV`; a static import of `use-no-color.ts` would load React too early.
- Vitest pins `FORCE_COLOR=0`; to assert an ANSI code, raise chalk's level on ink's own instance (`createRequire(resolve('ink')).resolve('chalk')`) inside the test and restore it. chalk is not a direct dep.
- Sprints list sorts newest-first, so a fresh render focuses the last-defined sprint in a two-sprint fixture.
