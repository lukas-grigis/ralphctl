---
name: project_layout_parity_and_capped_buffers
description: Execute view traps — behaviour wired in a width-specific wrapper silently misses the other layout; capped coalesced windows keep constant length; hook deps on array length
metadata:
  type: project
---

Wire per-panel behaviour (Esc claim, chips) in the shared component both width regimes render (`TasksPanelHost`), never in a wide-only wrapper. A wrapper-only Esc claim left the <140 col layout collapsing the card AND popping the route; every other Execute test renders at 100 cols, which hides it. Use `useOptionalOverlayState` so the host still renders in isolated tests.

**Why:** the wide path had its own wrapper (`ImplementMainArea`, now deleted) and the narrow path got a pre-built node. **How to apply:** when adding a keyed behaviour to the Tasks panel, test at the host with a mounted `useGlobalKeys`, not via a layout.

Never key a memo on `buffer.length` for a capped window: a full `useCoalescedBuffer` / `useSinkStream` window slides at constant length, so the memo freezes. Coalescer array identity is an exact change signal (no flush when not dirty).

Chips fed from a derived projection (`sprintState`) were dead code for months because only the isolated-panel tests passed it; fence the host construction site.
