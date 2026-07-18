---
name: esc-collapse-claim-seam
description: How the wide Implement view's Esc-collapse-before-pop works (claimEscape seam) — trace + why the undefined-sentinel ref matters
metadata:
  type: project
---

Wide-layout (≥140-col) Implement view Esc-collapse-before-pop wiring (branch feat/research-quickwins, reviewed 2026-07-18, PASS).

**The trace (who collapses the card):** On Esc, BOTH `useGlobalKeys` and `TasksPanel`'s `useTasksPanelInput` `useInput` handlers fire on the same keystroke.

- `use-global-keys.ts`: `if (key.escape && !ui.escapeClaimed) router.pop()` — the claim (counter-based `claimEscape`, `escapeClaims > 0`) suppresses the pop. It does NOT collapse anything.
- The actual collapse is `handleEscapeCollapse` in `tasks-panel-internals/keymap.ts` — `setExpandedTaskIds` deletes the focused id. So the claim + the panel's own handler are two halves; neither alone is enough.
- `LIVE_SIGNAL_TEXT` (signal stream) renders only inside `ExpandedProgressBlock`/`SignalsSection` which return null when `!cardExpanded` — so asserting `not.toContain(signalText)` is a genuine visual-collapse check.

**Why the undefined-sentinel ref (real bug the implementer caught):** the active task auto-expands from lazy initial state, so `focusedCardExpanded` is already `true` on first render. `useTaskCardState`'s NEW `onExpandedCardChange` report effect seeds `prevFocusedCardExpandedRef = useRef(undefined)` (NOT `useRef(current)`) so the mount-time `true` is reported once — establishing the claim BEFORE the operator's first keystroke. Seeding with `current` (as the sibling `onFocusedCardChange` does) would suppress that one report and the first Esc would pop instead of collapse.

**Asymmetry note:** the sibling `onFocusedCardChange` still seeds with `current`, so its consumer (sidebar highlight caret in `implement-sidebar.tsx`, `focusedTaskId`) shows no caret on first paint until first interaction. Pre-existing, cosmetic, out of scope — running task is still identifiable via its status glyph. Does not bite materially.

**Claim lifecycle:** `ImplementMainArea` holds `focusedCardExpanded` state + `useEffect(() => (focusedCardExpanded ? claimEscape() : undefined), [focusedCardExpanded, claimEscape])` — mirrors `sprint-detail-view.tsx:322`. Counter-based claim is reference-counted (safe under overlap); effect cleanup releases on collapse/focus-move-to-collapsed/unmount. `ImplementMainAreaProps = Omit<TasksPanelHostProps, 'onExpandedCardChange'>` — the component owns that prop, wide-layout callers can't pass it. Narrow path (`ExecuteLayout`) never mounts `ImplementMainArea`.
