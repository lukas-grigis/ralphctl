---
name: project_multi_flow_nav_design
description: Multi-flow Tab/Shift+Tab cycle + Ctrl+1..9 direct-jump design decisions (Jun 2026)
metadata:
  type: project
---

Tab/Shift+Tab + Ctrl+1..9 multi-flow navigation design — finalized Jun 2026.

**Why:** multi-flow-strip.tsx advertised `↹ cycle` and `[N]` chips but no handler existed anywhere in the codebase. CLAUDE.md and DESIGN-SYSTEM.md contradicted each other. Owner chose to implement, not remove.

**Core decisions:**

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

7. **Ctrl+digit risk:** In most terminal emulators Ctrl+1..9 do NOT generate a unique byte sequence (they send the raw digit bytes). Ink may not set `key.ctrl = true` for these. Fallback: use `Alt+1..9` (`key.meta && input === '1'`) which does generate distinct sequences in iTerm2/macOS Terminal. Implementer must verify before shipping.

8. **Strip hint:** change `↹ cycle` to `↹/⇧↹ cycle` in multi-flow-strip.tsx:97.

9. **keyboard-map.ts:** add `cycleSession: { keys: ['Tab', 'Shift+Tab'], label: 'cycle running sessions' }` and `jumpSession: { keys: ['Ctrl+1..9'], label: 'jump to Nth running session' }` to `globalKeys`.

10. **Docs:** CLAUDE.md:195 and DESIGN-SYSTEM.md:278 both need updating — the chord DOES exist after this. DESIGN-SYSTEM.md:278 currently says explicitly "there is no Tab / Ctrl+digit chord."

**Files:** use-global-keys.ts (core), keyboard-map.ts (map), multi-flow-strip.tsx (hint string), CLAUDE.md, DESIGN-SYSTEM.md.

**Why:** deadline decision — owner chose "implement" (not remove) when pointing at M3 in the UI/UX audit.

**How to apply:** when implementing, verify Ctrl+digit sequences in target terminals before committing to the chord; have the Alt+digit fallback ready.
