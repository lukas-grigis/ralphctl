---
name: project_ui_ux_stabilization
description: Sprint 'ui-ux-stabilization' — 45-finding audit + deep UX/nav/hints designs, planned 2026-06-02
metadata:
  type: project
---

Sprint `ui-ux-stabilization` was planned 2026-06-02. It covers:

- 5 robustness items (A1–A5): task repo saveAll lock, AbortSignal threading into shell runner, BlockedTask.blockKind discriminant, parallel-path verification, breadcrumb coalesce
- UI/UX functional: M1 (ideate draft→planned), M2 (createPr provider routing regex), L1 (token card id fix)
- Tab/Ctrl+N session nav (Design 2)
- Affordance-hints structural refactor + 9-finding sweep (Design 3)
- High-value UX wins from Design 1

**Why:** Project owner explicitly wants "really improve UI — it's a TUI" and "flows should be clear and really helpful."

**How to apply:** When asked about this sprint, check the impl plan in the conversation or ask for the plan doc.

Key decisions made in planning:

- A1: lock saveAll the SAME per-file .lock as update(); do NOT add a second locking path to unblock cascade — it already uses saveAll which will be locked after the fix.
- A2: thread AbortSignal into ShellRunOptions + kill killTree on signal abort; three leaf callers.
- A3: add `blockKind: 'upstream' | 'own'` to BlockedTask — requires schema migration for legacy tasks.json files.
- A4: parallel path already uses the sprint-scoped repo lock (covers saveAll); dependency-gate interaction in the parallel path is correct by construction; verification + regression test is sufficient — no code fix needed.
- A5: breadcrumb assigned to Wave 2 with other TUI chrome changes.
- Tab/Ctrl+N: router.replace() when current view is execute; router.push() otherwise. useSessionManager() already exported from sessions-context.tsx.
- Hints refactor: enabledWhen boolean on ViewHint is the structural fix; GLOBAL_HINTS replaced by footerGlobalHints derived from globalKeys.showInFooter tag.
- M1: append planSprintUseCase call after ideate-and-plan leaf in ideate/flow.ts; update e2e expectation from 'draft' to 'planned'.
