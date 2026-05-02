---
name: src TUI foundation shipped
description: The foundational TUI layer for src/ was built under application/tui/ and integration/ui/
type: project
---

The src TUI foundation was shipped in April 2026. Key decisions:

**PromptPort location:** Moved to `src/business/ports/prompt-port.ts` (not application/ui/) so both integration/ and application/ can import it without violating the ESLint architectural fence. The application/ui/prompt-port.ts and prompt-cancelled-error.ts re-export from business/ports.

**Why:** ESLint fence: `integration/` cannot import from `application/`. PromptPort needs to be accessible to both the Ink adapter (integration) and the composition root (application).

**How to apply:** When adding new cross-layer interfaces that both integration/ and application/ need, put them in business/ports/.

**TUI runtime location:** Under `src/application/tui/` (not integration/ui/tui/) because the TUI is a composition-root concern — it wires up SharedDeps and mounts the app.

**Sessions switcher:** Tab/Shift+Tab cycle sessions; Ctrl+1..9 direct-jump. Both live in `use-global-keys.ts` at the router level, receiving sessionManager as a prop from ViewRouter.

**ViewRouter receives sessionManager as prop** (not via getSharedDeps()) to keep the component pure and testable without wiring up the full dep graph.

**PlaceholderView pattern:** Browse + CRUD form views (sprint-list, ticket-add, etc.) have stub PlaceholderView entries in the router — foundation only. Full views are a follow-up task.

**Settings panel hand-writes rows** from CONFIG_DEFAULTS keys for now (not getAllSchemaEntries()) — TODO is inline in settings-view.tsx.
