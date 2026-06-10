---
name: project_ticket_add_flow_consolidation
description: ticket-add removed from Flows registry; add-tickets is the single Flows menu entry; a shortcut stays on add-ticket wizard (Jun 2026)
metadata:
  type: project
---

The Flows menu had two duplicate draft-sprint entries: `add-tickets` (full multi-ticket interactive chain with URL prefill, loop, batch save) and `ticket-add` (bare use-case shim, single append, no loop). Consolidated to one: `add-tickets` survives as the Flows menu entry titled "Add tickets".

**Why:** `add-tickets` strictly subsumes `ticket-add` for the interactive case — it handles N tickets per run, has GitHub/GitLab URL prefill via `IssueFetcher`, a per-ticket save-confirm, and an atomic batch save. `ticket-add` was a thin wrapper with no interactive affordances beyond what the surrounding `AddTicketView` wizard provided.

**What was removed:** `src/application/flows/ticket-add/manifest.ts` deleted. Registry entry and `ticketAddManifest` import removed from `src/application/registry.ts`. `ticket-add` removed from `SPRINT_SCOPED_FLOW_IDS`, all `ALLOWED_BY_STATUS` entries, and `viewRouteFor` in `flows-view.tsx`. `flows-visibility.ts` comment block updated.

**What survives:** `src/application/flows/ticket-add/flow.ts`, `ctx.ts`, `deps.ts` — all still used by:

- `src/application/ui/tui/views/add-ticket-view.tsx` (the single-ticket wizard behind the `a` shortcut)
- `src/application/ui/cli/commands/ticket.ts` (`ralphctl ticket add`)

**The `a` shortcut** (sprint detail + home menu) dispatches `router.push({ id: 'add-ticket', props: { sprintId } })` — the `AddTicketView` wizard — NOT the `add-tickets` chain. This is intentional: the shortcut gives a quick single-ticket append path; the Flows menu gives the full multi-ticket session via execute-view.

**How to apply:** When a flow has a registry entry AND a contextual shortcut that push the same user action, prefer the chain flow (multi-capable, execute-view backed) as the menu entry; keep the direct-view shortcut as the fast-path single-item affordance. The use-case building block (e.g. `ticket-add`) can remain alive for CLI + the wizard without being in the registry.
