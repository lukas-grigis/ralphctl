---
name: src TUI foundation shipped
description: Cross-layer PromptPort placement decision + TUI runtime location rationale
type: project
---

**PromptPort cross-layer decision:** PromptPort must be accessible to both `integration/` (Ink adapter) and
`application/` (composition root) without violating the ESLint architectural fence (`integration/` cannot import from
`application/`). The port was placed in a layer both can import — check current placement via
`find src -name "*prompt-port*"` before assuming a path.

**Why:** ESLint fence: `integration/` cannot import from `application/`.

**How to apply:** When adding new cross-layer interfaces that both `integration/` and `application/` need, place them in
a layer both can reach. Verify the fence by running `pnpm lint` after any cross-layer interface move.

**TUI runtime location:** Under `src/application/ui/tui/` (not `integration/`) because the TUI is a composition-root
concern — it wires up SharedDeps and mounts the app.

**Sessions switcher:** Tab/Shift+Tab cycle sessions; Ctrl+1..9 direct-jump. Both live in `use-global-keys.ts` at the
router level, receiving sessionManager as a prop from the view router.

**ViewRouter receives sessionManager as prop** (not via a shared deps accessor) to keep the component pure and testable
without wiring up the full dep graph.
