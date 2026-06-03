---
name: project_multi_flow_nav_design
description: Multi-flow Tab/Shift+Tab cycle + Ctrl+1..9 direct-jump design decisions (Jun 2026)
metadata:
  type: project
---

Tab/Shift+Tab + Ctrl+1..9 multi-flow navigation — SHIPPED Jun 2026. The chord exists; `cycleSession` /
`jumpSession` are declared in `keyboard-map.ts`. Ctrl+1..9 is gated on the kitty keyboard protocol
(iTerm2 / kitty / WezTerm / foot — Ink only surfaces `key.ctrl` for digits via the CSI-u extension);
in other terminals it is an inert no-op while Tab cycling works everywhere.

**Core decisions (the durable location/gating facts):**

1. **Location:** `use-global-keys.ts` — same place as `S`/`P`/`x` navigation chords. Tab/Ctrl+digit are global chords, not per-view.

2. **Session list:** `sessionManager.list().filter(s => s.descriptor.status === 'running')`, ordered by `startedAt` (already the canonical order in SessionManager.list()). Index `[N]` in strip = Ctrl+N target.

3. **"Focus a session" mechanic:**
   - `router.replace(...)` when current view is already `execute` — keeps stack depth stable.
   - `router.push(...)` when coming from a non-execute view — preserves prior nav context.
   - Target entry: `{ id: 'execute', props: { sessionId: target.descriptor.id } }`.
   - Do NOT push via x→SessionsView — navigate directly.

4. **Gating (confirmed safe, no extra work needed):**
   - All six prompt types (TextPrompt, TextAreaPrompt, SelectPrompt, MultiSelectPrompt, PathPickerPrompt, ConfirmPrompt) call `ui.claimPrompt()` on mount → `ui.promptActive = true` → `useGlobalKeys({ disabled: true })` → Tab block never reached.
   - help/progress overlay early-returns in use-global-keys are above the insertion point → Tab is swallowed.
   - Cancel-scope overlay: does NOT claim promptActive (known bug L3) but Tab cycling away from it is acceptable behavior — picker is lightweight modal, view unmount is clean.

5. **Tab from non-execute view:** `currentIdx = -1`. Forward Tab → index 0 (first session). Backward Shift+Tab → last session. Intuitive enter-from-edges behavior.

6. **No-op cases:** 0 running sessions → silent no-op. Ctrl+N with N > count → silent no-op.

7. **keyboard-map.ts:** `cycleSession: { keys: ['Tab', 'Shift+Tab'], … }` and `jumpSession: { keys: ['Ctrl+1..9'], … }` live in `globalKeys`; the help overlay is generated from this map.

**Files:** `use-global-keys.ts` (core), `keyboard-map.ts` (map), `multi-flow-strip.tsx` (strip hint).

**How to apply:** Tab/Shift+Tab and Ctrl+1..9 operate over RUNNING sessions only and are suspended while a prompt / overlay is mounted; both are global chords. Ctrl+1..9 only fires under a kitty-protocol terminal — treat it as an enhancement over the always-available Tab cycling, and label it accordingly in any help / hint copy.
