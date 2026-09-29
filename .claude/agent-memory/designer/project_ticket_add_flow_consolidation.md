---
name: project_ticket_add_flow_consolidation
description: One view-backed add-ticket flow serves both the Flows menu and the `a` shortcut
metadata:
  type: project
---

When a registry entry and a contextual shortcut trigger the same user action, route both to one view-backed flow
(`add-ticket`, `AddTicketView`) and let the wizard absorb the other's capability (its "Add another ticket?" loop) rather
than keeping two competing entries.
