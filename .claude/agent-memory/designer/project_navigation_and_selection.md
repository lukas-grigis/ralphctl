---
name: project_navigation_and_selection
description: Cross-session navigation and selection coherence — the S picker, Tab/Ctrl+1..9 session chords, and the persist-vs-follow split in selection-context
metadata:
  type: project
---

One subsystem: `runtime/selection-context.tsx` + `use-global-keys.ts` + `runtime/keyboard-map.ts`.

## Cross-project sprint picker (`S`)

`PickSprintView` was extended rather than replaced: it loads all sprints + projects and renders them
grouped by project, current project first. A local `scopeAll` boolean (default `true`) filters to
`selection.projectId`; `t` toggles the scope inline. `S` stays the global pick-sprint chord.

**Rejected alternatives, and why:** a second global chord forces discovery of another key; expandable
project rows mix two interaction models. The grouped-list + `t`-toggle is additive — it strictly widens
what `S` shows without breaking the existing mental model. **Use this same pattern for any future
multi-project picker** (tickets, tasks) rather than minting a new global chord.

Orphaned sprints (their `projectId` has no project entry) render under an "Unknown project" group with
`inkColors.warning` + `glyphs.warningGlyph`. Degraded but navigable — not an error, not hidden.

`recentSprints` in `state-snapshot.ts` deliberately stays project-scoped: it feeds the home-view inline
"what was I just doing here" list. The picker does its own full load.

## Selection setters — three of them, and the distinction is load-bearing

- `setProject()` clears `sprintId` as a side effect. A cross-project pick must therefore NEVER be two
  setter calls — it fires `onChange` twice and flickers.
- `setProjectAndSprint(...)` — atomic, **persists** to disk. This is what an explicit user pick uses.
- `followFocusedRun(...)` — atomic, **deliberately does NOT persist**. This is what passive focus
  convergence uses.

**Why the split exists (do not collapse it):** focus-driven convergence was shipped, then reverted
because peeking at an old session silently re-pinned its sprint and the next boot landed on the wrong
one. It was later re-shipped correctly by adding the non-persisting setter — the screen matches the
action, but an exploratory Tab-cycle cannot corrupt the next boot's default. Convergence also fires the
`lastSwitch` toast, so the switch is visible rather than silent.

**The skip-guard must be value-keyed, not a one-shot flag.** A boolean `skipNextPersist` flaked
intermittently: React can coalesce the convergence write with an unrelated one into extra/reordered
effect passes, letting an unrelated persist invocation spend the flag before the guarded write is even
visible — the converged tuple then leaks to `onChange`. `skipPersistForRef` instead holds the exact
`{projectId, projectLabel, sprintId, sprintLabel}` tuple about to be written; the persist effect skips
only while the current values still match, and clears on match so a later genuinely-explicit pick of the
same pair is not mistaken for it. Immune to render ordering because it asks "do the values match", not
"did some effect run first".

Converging onto a closed/removed pin is guarded by a tri-state probe (`'checking' | 'available' |
'unavailable'`) in `execute-view-internals/use-pinned-sprint-context.ts` — an optimistic boolean
defaulting to `true` races the async check. The effect is loop-safe by construction: its own write makes
`pinnedSprintId === selection.sprintId` on the next render, tripping the guard.

**Trap worth remembering:** a task description asked to reintroduce this behaviour verbatim, framed as
"closes a verified design gap", for code that carried an inline `NOTE deliberately NO selection
convergence here`. The instruction was stale, not malicious. When an instruction asks you to undo
something the code explicitly marks as deliberate, run `git log -- <file>` on the area first, then
implement the INTENT while fixing the defect that caused the revert — neither silent compliance nor
silent refusal.

## Session chords: Tab / Shift+Tab and Ctrl+1..9

Both are global chords in `use-global-keys.ts` (alongside `S`/`P`/`x`), declared in `keyboard-map.ts` as
`cycleSession` and `jumpSession` — the help overlay is generated from that map.

- They operate over **running sessions only**: `sessionManager.list().filter(s => s.descriptor.status
=== 'running')`, ordered by `startedAt`. Strip index `[N]` is the Ctrl+N target.
- Focusing a session: `router.replace(...)` when the current view is already `execute` (keeps stack
  depth stable), `router.push(...)` otherwise (preserves prior nav context). Target entry is
  `{ id: 'execute', props: { sessionId } }` — navigate directly, never via SessionsView.
- Tab from a non-execute view starts at `currentIdx = -1`, so forward lands on the first session and
  Shift+Tab on the last.
- Zero running sessions, or Ctrl+N beyond the count, is a silent no-op.
- Suspended while a prompt or overlay is mounted: all prompt types call `ui.claimPrompt()`, which
  disables the global key handler; the help/progress overlay early-returns above the insertion point.
- **Ctrl+1..9 requires the kitty keyboard protocol** (iTerm2 / kitty / WezTerm / foot — Ink only surfaces
  `key.ctrl` for digits via the CSI-u extension). Elsewhere it is an inert no-op. Treat it as an
  enhancement over the always-available Tab cycling and label it that way in help and hint copy.
