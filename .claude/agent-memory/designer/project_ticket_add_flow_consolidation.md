---
name: project_ticket_add_flow_consolidation
description: add-tickets chain flow removed entirely; add-ticket (singular) is the single canonical Flows-menu + shortcut entry (Jun 2026)
metadata:
  type: project
---

The Flows menu had two duplicate draft-sprint entries: `add-tickets` (full multi-ticket interactive chain with URL prefill, loop, batch save) and `ticket-add` (bare use-case shim, single append, no loop). Consolidated to one: the `add-tickets` chain flow was completely removed (commit a04085f3 deleted all its files), and the single-ticket `add-ticket` wizard survives as the ONE canonical path — registered via `ticketAddManifest` from `src/application/flows/add-ticket/manifest.ts` with id `'add-ticket'` and title `'Add ticket'`.

**Why:** `add-tickets` strictly subsumes `ticket-add` for the interactive case — it handles N tickets per run, has GitHub/GitLab URL prefill via `IssueFetcher`, a per-ticket save-confirm, and an atomic batch save. `ticket-add` was a thin wrapper with no interactive affordances beyond what the surrounding `AddTicketView` wizard provided.

**What was removed:** the `add-tickets` chain flow directory (manifest, ctx, deps, flow) deleted outright in commit a04085f3. Its registry entry and any distinct `add-tickets` id were removed from `src/application/registry.ts`.

**What survives:** `src/application/flows/add-ticket/manifest.ts`, `flow.ts`, `ctx.ts`, `deps.ts` — all still used by:

- `src/application/ui/tui/views/add-ticket-view.tsx` (the single-ticket wizard behind the `a` shortcut)
- `src/application/ui/cli/commands/ticket.ts` (`ralphctl ticket add`)

**The `a` shortcut** (sprint detail + home menu) dispatches `router.push({ id: 'add-ticket', props: { sprintId } })` — the `AddTicketView` wizard. This is the SAME id the Flows menu routes to; there is no longer a separate multi-ticket chain flow — the wizard's own "Add another ticket?" confirm loop (see `add-ticket-view.tsx`) now covers the multi-ticket session that `add-tickets` used to provide.

**How to apply:** When a flow has a registry entry AND a contextual shortcut that push the same user action, prefer consolidating to the single view-backed flow if it can absorb the other's capability (here: the wizard grew a "loop back to add another" confirm to absorb the chain's batch-session behavior) rather than keeping two competing menu entries alive.
