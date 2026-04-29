# UX Audit — Ink TUI

This document catalogues every router-visible view in `src/integration/ui/tui/views/**`
across four dimensions: keyboard shortcuts, layouts/navigation, look & feel, and
interaction patterns. For each inconsistency, the chosen winning pattern is named
and justified by referencing the existing in-app usage that already follows it.

The companion implementation lives in `src/integration/ui/tui/keyboard-map.ts`
(canonical shortcut table), `src/integration/ui/tui/components/help-overlay.tsx`
(generated help surface), and the runtime hook
`src/integration/ui/tui/runtime/use-global-keys.ts` (now reads its bindings from
the map). Old bindings have been deleted — there is no compatibility shim.

## Audit Scope

Every file under `src/integration/ui/tui/views/**`. Components in `components/`
are visited only when a view embeds them (`ListView`, `RemovalWorkflow`,
`ResultCard`, `Spinner`, `StickyNotification`).

Per-view sections below collapse "no issue" rows so the audit reads as a
work-list. The four-dimension rubric appears once at the top; subsequent views
only mention dimensions where an issue was identified, with an explicit
"no issues across the four dimensions" line where nothing surfaced.

## Winning Patterns (the new standard)

These are the patterns that already exist in the strongest form somewhere in the
app and become the canonical choice everywhere.

### Keyboard

- **Global hotkeys**: `Esc` back · `h` home · `s` settings · `d` dashboard ·
  `x` running runs · `?` keyboard help · `!` doctor · `q` quit (only at home root).
  Source: previously co-located in `view-router.tsx` and `use-global-keys.ts`,
  now centralised in `keyboard-map.ts`. `?` was the doctor shortcut and is
  reclaimed for the help overlay (the conventional terminal-app help binding —
  `less`, `vim`, `htop`, `lazygit`, `k9s`, `gh dash` all use `?`). Doctor moves
  to `!` (semantically "alert / health check"; the only unused punctuation key
  that no list-local letter can collide with).
- **List navigation**: `↑/↓` plus vim-style `j/k`, `PgUp/PgDn`, `Enter` opens.
  Source: `settings-panel.tsx` already supports `j/k`; `list-view.tsx` did not.
  `j/k` is now part of the canonical map and reaches both surfaces through it.
- **Per-list actions**: `a` add, `e` edit, `r` remove, `f` filter, `n` new,
  `c` set-current, `t` status, `o` onboard. Source: `ticket-list-view.tsx`,
  `task-list-view.tsx`, `project-list-view.tsx`, `sprint-list-view.tsx` —
  the existing convention already in use, codified.
- **Destructive view-local keys**: uppercase variant `X` for "cancel highlighted
  row in runs list" because lowercase `x` is the global hotkey that lands on
  this same view (and would otherwise bounce the user back to it). Same
  reasoning for `D` (detach in `execute-view`) — `d` is dashboard. The
  capitalisation seam is documented in the map.

### Layout / Navigation

- **Frame**: every view mounts inside `<ViewShell>`; `ViewShell` owns header
  - spacing + `<KeyboardHints />`. Views never render their own bottom hint
    strip or header box. Source: contract documented in `REQUIREMENTS.md §
UI Contract`. Most views already comply.
- **Hints**: declared via `useViewHints([...])`. Hints render through
  `<KeyboardHints />` between body and status bar. The status bar shows ONLY
  the global hotkeys, computed from the canonical map.
- **Drill-in**: `Enter` opens the highlighted item; `Esc` pops the frame.
  Source: ListView + view-router contract — the dominant pattern across
  browse views.

### Look & Feel

- **Colors**: every color comes from `inkColors` (`theme/tokens.ts`). Semantic
  state only — `success` / `error` / `warning` / `info` / `muted` / `highlight`.
  Brand colors (`primary` / `secondary`) are reserved for the banner +
  section stamps + quote rail.
- **Glyphs**: every symbol comes from `glyphs` (`theme/tokens.ts`). No
  inlined unicode characters. The full curated set is documented in
  `REQUIREMENTS.md § Glyphs`.
- **Spacing**: every `marginTop` / `paddingX` value comes from `spacing`
  (`theme/tokens.ts`). No magic numbers.
- **State surfaces**: `<Spinner />` for loading, `<ResultCard kind=…/>` for
  success / warning / error / info / empty. No raw `<Text color="red">…</Text>`
  failures, no inline "(empty)" strings except inside `<ListView />`'s
  `emptyLabel` prop.

### Interaction

- **Prompts**: every interactive prompt goes through `getPrompt()`. No direct
  `useInput` for typing-style input. Cancellation throws `PromptCancelledError`.
- **Destructive confirmations**: a single `confirm` prompt with `default: false`,
  worded `"<Action> <entity>?"`, dispatched via `<RemovalWorkflow />` (the
  shared component now used by sprint / ticket / task / project / repo
  removal flows). Cancel = Esc / Ctrl+C; confirm = `Enter`. Button order is
  No-by-default (so the user can't fat-finger destruction). Source:
  `removal-workflow.tsx` is the existing canonical implementation.
- **Async**: spinner during the in-flight phase; ResultCard at the terminal
  state; `Enter` / `Esc` from the terminal state pops the view. Source:
  `use-workflow.ts` codifies this discriminated-union state machine, and
  every workflow view in `views/workflows/**` already uses it.

---

## Per-View Findings

### `home-view.tsx`

- **Keyboard**: declares `b` (browse), `↑/↓`, `Enter`, `Esc`. Owns `h` locally
  to drop a submenu without leaving Home (router-level `h` would also remount
  Home but the local handler also clears `mode` state). Already aligned with
  the canonical map. **No issue**.
- **Layout**: bare `<ViewShell>` (no SectionStamp) — Home is the only view
  intentionally exempt because it carries the banner + pipeline map. **No issue**.
- **Look & feel**: tokens-only. **No issue**.
- **Interaction**: `'busy'` mode renders bare text "Running … `${label}`" instead
  of `<Spinner />`. Winning pattern: `<Spinner label="Running … {label}" />`
  (used everywhere else, e.g. workflow views). **Fix applied.**

### `dashboard-view.tsx`

- **Keyboard**: no view-local keys (read-only destination). **No issue**.
- **Layout**: standard `<ViewShell title="Dashboard">`. **No issue**.
- **Look & feel**: defines an inline `PanelHeader` that hand-rolls the section
  rule with `glyphs.sectionRule.repeat(30 - label.length)`. Cosmetic; uses
  tokens, not blocked.
- **Interaction**: spinner + ResultCard + tokens — aligned. **No issue**.

### `execute-view.tsx`

- **Keyboard**: `c` cancel, `D` detach, `Enter` back-on-terminal. The `D`
  uppercase choice is correct (see "Destructive view-local keys" above).
  However the `D` constant lives inline in the file — this is the kind of
  inline literal the canonical map subsumes. **Fix applied:** `D` now comes
  from `getBindingFor('execute.detach')`.
- **Layout / look / interaction**: aligned (panel headers are cosmetic).

### `attach-view.tsx`

- **Keyboard**: `Enter` on terminal pops; otherwise no view-local keys
  (`Esc` is handled globally as "back / detach"). **No issue**.
- **Layout / look / interaction**: aligned with execute view. **No issue**.

### `running-executions-view.tsx`

- **Keyboard**: declares `X` (uppercase) cancel + lists `↑/↓`, `Enter`, `Esc`
  in hints. The uppercase choice is correct. **Fix applied:** the `X` literal
  now comes from `getBindingFor('runs.cancel')` so the hints text stays in
  sync with the actual handler.
- **Layout / look / interaction**: aligned. **No issue**.

### `settings-view.tsx` + `settings-panel.tsx`

- **Keyboard**: `↑/↓`, `j/k`, `Enter`, `Esc`. Already aligned with the new
  canonical list-navigation triad. **Fix applied:** the literal `j` / `k`
  checks now read from the canonical map.
- **Layout / look / interaction**: aligned. **No issue**.

### `phases/refine-phase-view.tsx` · `plan-phase-view.tsx` · `close-phase-view.tsx`

- **Keyboard**: `Enter` runs the phase, `Esc` pops. **No issue**.
- **No issue across the four dimensions** — these views set the standard for
  "long-running phase".

### `onboarding-view.tsx`

- **No issue across the four dimensions**.

### `browse/sprint-list-view.tsx`

- **Keyboard**: declares `n` new, `f` filter, `c` set current, `r` remove. The
  `n` / `r` / `f` letters match the canonical map; `c` for "set current" is a
  per-list semantic.
- **No issue across the four dimensions** — j/k now flow through the canonical
  map automatically when ListView is upgraded.

### `browse/ticket-list-view.tsx` · `task-list-view.tsx` · `project-list-view.tsx`

- **Keyboard**: `a` / `e` / `r` per-list set, plus list-specific extras
  (`f` filter on tasks; `t` status on tasks; `o` onboard on projects).
  All aligned with the canonical map.
- **No issue across the four dimensions**.

### `browse/sprint-show-view.tsx`

- **Keyboard**: `↑/↓` move between section rows, `Enter` opens the highlighted
  section. **No issue across the four dimensions**.

### `browse/ticket-show-view.tsx` · `task-show-view.tsx` · `project-show-view.tsx`

- **Keyboard**: detail-action set (`e` edit, `t` status, `r` remove, `a` add
  repo, `o` onboard) — all aligned. **No issue across the four dimensions**.

### `browse/doctor-view.tsx`

- **No issue across the four dimensions**.

### `browse/progress-show-view.tsx` · `evaluations-view.tsx` · `evaluation-show-view.tsx` · `feedback-view.tsx`

- Read-only browse views; navigation hints only. **No issue across the four
  dimensions**.

### Workflow views (`workflows/**`)

The 24 workflow views (sprint-create, ticket-add, task-add, project-add,
project-onboard, …) all wrap `useWorkflow()` and render a `<ResultCard />`
on terminal. None have view-local keys beyond `Enter / Esc back`.

- **No issue across the four dimensions** — these set the canonical workflow
  surface.

### Removal flows

All five removal views delegate to `<RemovalWorkflow />` (the canonical
single-confirm pattern). **No issue across the four dimensions** — these
already implement the standard the audit elevates.

---

## Hard-Cutover Decisions

| Old binding             | New binding                                  | Reason                                                                                              |
| ----------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `?` opened doctor       | `?` opens help overlay                       | `?` is the universal terminal-app help key. Reclaim it. The single most impactful consistency gain. |
| Doctor had no free key  | `!` opens doctor                             | "alert / health-check" semantics. Free across every list-local action. Hint reads `!` directly.     |
| Inline `'D'` in execute | `getBindingFor('execute.detach').keys[0]`    | Detach lookup flows through the canonical map so help overlay and handler stay in sync.             |
| Inline `'X'` in runs    | `getBindingFor('runs.cancel').keys[0]`       | Same as above.                                                                                      |
| `j/k` only in settings  | `j/k` everywhere a `<ListView />` is mounted | Vim-style nav was already in settings; promoting to all list surfaces is the standardisation move.  |

There is **no compatibility shim** for the old bindings. `?` no longer
opens doctor; pressing the old key in any view fires the new help overlay
instead. This is intentional — the ticket calls for hard cutover.
