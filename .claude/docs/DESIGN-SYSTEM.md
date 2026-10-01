# RalphCTL — TUI Design System

The single source of visual truth for the Ink TUI. Every view, prompt, and component follows the tokens,
patterns, and contracts in this document. Before adding a new component or one-off glyph, read this first —
most needs are already covered.

Companion docs:

- [REQUIREMENTS.md § TUI](./REQUIREMENTS.md#tui) — the testable acceptance criteria.
- [ARCHITECTURE.md § Terminal UI Layer](./ARCHITECTURE.md#terminal-ui-layer-srcapplicationui) — file layout and
  runtime wiring.
- `src/application/ui/tui/theme/tokens.ts` — the tokens themselves, in code.

## 1. Design philosophy — "Technical Letterpress"

A developer tool should read like a well-set page, not a game HUD. That gives three rules:

1. **Typography carries hierarchy.** Bold + dim are the workhorse. Color is reserved for semantic state.
2. **Glyphs are a curated family.** One set, used consistently. A new glyph is a design decision, not a convenience.
3. **Personality is concentrated, not smeared.** Ralph lives in the Home banner and the occasional pull-quote —
   not on every screen.

If a change trades legibility for decoration, it fails the test. Restraint is the aesthetic.

## 2. Tokens

All tokens are exported from `src/application/ui/tui/theme/tokens.ts`. **Never inline a hex code, a unicode
glyph, or a magic spacing number in a view** — import the token.

### 2.1 Color — `inkColors`

Semantic only. Each color means the same thing on every surface.

| Token       | Meaning                                                   |
| ----------- | --------------------------------------------------------- |
| `success`   | completion, pass, done                                    |
| `error`     | failure, blocked, fail                                    |
| `warning`   | in-progress, draft, paused                                |
| `info`      | annotations, meta, help, info cards, spinner default      |
| `muted`     | secondary text, inactive, disabled                        |
| `highlight` | focus, selection, "next" marker                           |
| `primary`   | brand accent — section stamps, active phase               |
| `secondary` | personality — quote rail, Ralph flavor bits               |
| `rule`      | keyline / divider tone — recessive card + divider borders |

Rules:

- Never `color="red"` / `"green"` / `"yellow"` — always `inkColors.error` / `inkColors.success` / `inkColors.warning`.
- **Focus pattern** is inline: `<Text color={inkColors.highlight} bold>…</Text>`. There is no separate `focus` token.
- Truecolor hex; terminals without truecolor fall back to ANSI-256 automatically.

### 2.2 Glyphs — `glyphs`

Canonical set. If a view needs a symbol not in this list, **add it to `glyphs` first** (and document it here).

| Group           | Tokens                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase / status  | `phaseDone ■`, `phaseActive ◆`, `phasePending ◇`, `phaseDisabled ◌`                                                                                         |
| Cursors         | `actionCursor ▸`, `selectMarker ›`, `focusBar ▍` (picker focus rail), `caretBlock █` (text-input caret — same char as `barFilled`, separate role)           |
| Disclosure      | `disclosureCollapsed ▸`, `disclosureExpanded ▾` (collapsible rows, e.g. Tasks-panel commit messages)                                                        |
| Section markers | `badge ▣`, `sectionRule ━`                                                                                                                                  |
| State           | `check ✓`, `cross ✗`, `warningGlyph ⚠`, `infoGlyph i`, `modified ✎`, `unknownGlyph ?` (undetermined verdict, never tinted), `stethoscope ✚` (footer doctor) |
| Bullets         | `bullet ·`, `inlineDot ·`, `emDash —`, `arrowRight →`, `activityArrow ↳`, `refresh ↻`                                                                       |
| Separators      | `pipe │`                                                                                                                                                    |
| Motion          | `spinner` (braille frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`), `busyDot ●` (gen-eval busy indicator)                                                                              |
| Meters          | `barFilled █`, `barEmpty ░` (fixed-width progress meters — ratio reads by density alone)                                                                    |
| Clip markers    | `clipEllipsis …`, `collapseExpand ▼ more`                                                                                                                   |
| Overflow cues   | `moreAbove ▴`, `moreBelow ▾` (windowed-list `OverflowRow` "N more" rows)                                                                                    |
| Personality     | `quoteRail ┃`                                                                                                                                               |

Do not mix glyph families (no `✔` from one set and `✓` from another). No emoji in TUI surfaces.

**`glyphFor(signalKind)`** — exported from `tokens.ts`. Maps each `SignalKind` to a shape-distinct glyph
that conveys meaning without colour, for use under `NO_COLOR=1`. Kinds whose label already reads distinctly
(`done` / `script` / `proposal` / `skills`) return the empty string. Import from tokens; do not inline the
character.

### 2.3 Spacing — `spacing`

Vertical rhythm comes from a handful of constants. Every `marginTop` / `marginBottom` / `paddingX` value in a
view must reference one.

| Token         | Value | Use                                      |
| ------------- | ----- | ---------------------------------------- |
| `section`     | 1     | Blank line between top-level sections    |
| `actionBreak` | 2     | Breath before a final CTA / decision row |
| `indent`      | 2     | Left-indent for nested content / bullets |
| `gutter`      | 1     | Internal padding inside card-like boxes  |
| `cardPadX`    | 1     | Horizontal padding inside cards          |

`ViewShell` handles header → body → hints spacing. Views only add spacing **inside** their body.

### 2.4 Typography

Ink gives you three knobs: `bold`, `dimColor`, and `color`. Use them like this:

| Role                           | Style                                                            |
| ------------------------------ | ---------------------------------------------------------------- |
| Section title (stamp)          | `bold` + `color={inkColors.primary}`                             |
| Field label                    | `dimColor` + trailing colon                                      |
| Field value                    | default weight                                                   |
| Selection / focused row        | `bold` + `color={inkColors.highlight}` + `actionCursor ▸` prefix |
| Secondary / help text          | `dimColor`                                                       |
| Status word (`DONE`, `FAILED`) | semantic `color` + `bold`                                        |

Never use `underline`. It reads as a hyperlink in most terminals and we don't have any.

### 2.5 Field alignment

Field lists use `FIELD_LABEL_WIDTH = 14` from tokens. That fits the longest label in the app
(`Repositories:`, `Pull request:`) with its colon. Override only when a specific view demands it.

### 2.6 Responsive layout — breakpoints

All terminal-width decisions use the named breakpoints exported from `src/application/ui/tui/theme/tokens.ts`.
**Never hardcode a raw column number in a view** — import the token or helper.

| Name  | Threshold (cols) | Typical layout                                 |
| ----- | ---------------- | ---------------------------------------------- |
| `sm`  | ≥ 80             | Single-column stack; minimum supported width   |
| `md`  | ≥ 100            | Narrow multi-column; Execute compact-rail mode |
| `lg`  | ≥ 140            | Two-column viable (rail + main)                |
| `xl`  | ≥ 180            | Three-column viable (rail + main + context)    |
| `xxl` | ≥ 220            | Extra room; rails and context can grow         |

**Helper functions** (all exported from `tokens.ts`):

- `breakpointFor(columns): Breakpoint` — returns the largest satisfied breakpoint key.
- `fluid(columns, { min, max, ratio }): number` — clamps `floor(columns × ratio)` to `[min, max]`.
  Use for numeric widths that should grow proportionally but never overwhelm or vanish.
- `responsive<T>(columns, { sm, md?, lg?, xl?, xxl? }): T` — picks the value for the active breakpoint,
  falling through to the next smaller specified value. `sm` is required as the floor.
- `listCapacity(rows, { rowHeight?, chromeRows?, min, max? }): number` — the row-count counterpart to
  `fluid`, for windowed lists. Computes `floor(max(0, rows - chromeRows) / rowHeight)`, floored at `min`
  and (if supplied) capped at `max`. `chromeRows` defaults to `LIST_CHROME_ROWS` (12 — the app chrome +
  `StatusBanner` + `PromptHost` + footer stack every view pays; conservative since the chrome shrank to 5 rows); pass an explicit `chromeRows`
  when a view's own chrome (section stamp, summary line, footer hint, …) adds more. `rowHeight` defaults
  to `1`; set it higher for a card-based list whose rows span several terminal lines. Replaces the
  per-view `Math.max(min, terminalRows - ownChromeConstant)` idiom (the sprint picker, now the context switcher, used to hand-roll
  this as `VERTICAL_CHROME_ROWS` / `MIN_VISIBLE_ROWS`).

**React hook**: `useBreakpoint(): { breakpoint, columns, rows, atLeast(target) }` — re-derives on every
`SIGWINCH`, so layouts react cleanly on terminal resize. Import from
`src/application/ui/tui/runtime/use-breakpoint.ts`.

**First concrete consumer — Execute-view rail width:**

```
resolveRailWidth(columns):
  < xl  (< 180)  →  RAIL_WIDTH = 28       (fixed; lg uses two-column, no context column)
  ≥ xl  (≥ 180)  →  fluid(cols, { min: 36, max: 56, ratio: 0.22 })
```

`COMPACT_RAIL_WIDTH = 6` applies at `md` (100–139); only status glyphs are shown, no labels.
`tokens.ts` also exports `CONTEXT_WIDTH` for the right context column — touch those via
`resolveRailWidth` and the breakpoint helpers, not via new magic numbers.

## 3. Layout anatomy

The frame is one fixed-height column the size of the terminal. The app chrome sits at the top and is
owned by `Layout` (`App.tsx`); every view mounts through `<ViewShell>` below it.

```
 0  ralphctl │ [1 Work]  2 Sprints   3 Projects   4 Runs ●1   5 System ✚2     ? help   ← <TabBar>
 1   ▣ Sprints › ready to implement          Hello Python › ready to implement [ACTIVE]   ← <LocationBar>
 2  ────────────────────────────────────────────────────────────────────────────────   ← rule (Divider)
    ┌─ ViewShell ───────────────────────────────────┐
    │  <body>  ← the view-specific content (scrolls) │
    │  <StatusBanner />  ← dismissible banners       │
    │  <PromptHost />  ← inline prompts (auto)       │
    └────────────────────────────────────────────────┘
 N-2 ────────────────────────────────────────────────────────────────────────────────   ← rule
 N-1  ↑/↓ move · ↵ open · esc work · ? help                                              ← <StatusBar>, one hint row
```

Chrome is **five rows** at any size: tab bar, location line, rule at the top; rule + one hint row at the
bottom. There is no title row inside the body — `ViewShell` publishes its `title` / `subtitle` / `right`
node into `ViewTitleContext` (`runtime/view-title-context.tsx`) and the location line shows them. The tab
bar and location line hide while `router.activeSection === 'none'` (the first-run welcome / create-project
wizard).

**Views never render their own header, hint strip, or status bar.** `ViewShell` + `Layout` own all of it.

**Content-first header.** The wordmark (9–12 rows) is reserved for the Work root and only when the terminal
can spare it: `resolveBannerMode({ routeId, columns, rows, userToggle })` returns `full` only for route `home`
at `columns ≥ breakpoints.md` and `rows ≥ 40`, otherwise `compact` — which now renders **nothing** (the
tab bar's `ralphctl` text is the brand). `b` (`UiState.bannerCompact`, bound by `HomeView` as `b banner`)
flips whichever mode was chosen on Home only. `ViewShell` is the only caller that mounts `Banner`;
anything that reserves chrome for the header calls the same function.

**Overlays and the chrome.** Help, progress and evaluation are full-frame documents and hide the chrome with
the view. The context switcher is a light overlay about the context shown in the location line, so the chrome
stays and the switcher pins its own footer (§ 6.2a).

## 4. Component inventory

All components live in `src/application/ui/tui/components/`. Use these. Don't write a sibling that does 90% of
the same job.

### 4.1 Shell + chrome

| Component                | Purpose                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ViewShell`              | Frame for every view. Owns body + status + prompt + footer; publishes its title to the location line.                                                                                                  |
| `TabBar`                 | Row 0. `ralphctl │` + the five sections + `? help` (`· v<version>` and `↑ v<latest>` from `lg`). Active tab wrapped in `[ ]` (survives NO_COLOR) + primary bold. Layout in `tab-bar-layout.ts` (pure). |
| `LocationBar`            | Row 1. Left: `▣ <Section> › <crumb> — <subtitle>`; right: `<project> › <sprint> [STATUS]` (words `project`/`sprint` + `S switch` from `lg`). Fit order in `location-layout.ts` (pure).                 |
| `ContextSwitcher`        | `S` / `P` overlay: sprint + project switcher. Mounted in `Layout`, never navigates (§ 6.2a). Rows/grouping in `context-switcher-internals/`.                                                           |
| `SystemView`             | The System section hub: Settings / Skills / Doctor with live one-line summaries; Doctor first while it warns or fails.                                                                                 |
| `StatusBar`              | Footer: rule + ONE width-budgeted hint row (§ 6.1a). Doctor health and the session count are tab badges now. `FooterBar` is the same footer for an overlay that hides the view.                        |
| `hint-budget.ts`         | `fitHints` — pure width-budgeting of the footer strip. Views publish `useViewKeys`.                                                                                                                    |
| `HelpOverlay`            | Modal `?`-key overlay, mounted once in the App Layout; scoped to the route (§ 6.5).                                                                                                                    |
| `Banner`                 | The wordmark; `mode` from `resolveBannerMode`. Renders only on a roomy Work root; `compact` renders nothing.                                                                                           |
| `MemoryPressureBanner`   | Heap-pressure strip mounted at App root. Subscribes to the EventBus.                                                                                                                                   |
| `ChainLogDegradedBanner` | Latched warning when the on-disk `chain.log` sink can't keep up. Mounted at App root.                                                                                                                  |

**Tab badges.** Compact below `lg`: Runs `●N` (running sessions, hidden at 0), System `✚N` (warning tone
for warnings, error tone for failures — failures win — hidden when every probe passes). From `lg`:
`● N live`, `✚ N warning(s)` / `✚ N failing`. `unknown` probes are neutral. When the bar cannot fit, it
degrades (wordmark, then padding, then badges, then the right side) so the five labels always stay whole.

**Location line fit order.** Drop the subtitle, then trim the trail from its start (`▣ … › Sprint`), then
drop the `[STATUS]` chip (whole or not at all — never `[ACTI`), then shorten the project / sprint names with
`…`. The row is always exactly one line. Crumbs come from `ROUTE_LABELS` in `runtime/nav-tree.ts`; detail
routes label themselves from route props (`sprintName` / `projectName`), and Execute names the flow it runs
(`ViewShell`'s `crumb`). When an Execute run is focused, both right-hand labels come from the run's pinned
context — never one from the run and one from the global selection.

### 4.2 Content surfaces

| Component        | Purpose                                                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Card`           | Bordered content box. Base for ResultCard.                                                                                                                                                                                                                                                                    |
| `ResultCard`     | Chain-settlement outcome card for the Execute-view footer: `kind` is `success` / `failed` / `aborted`. Carries `title`, `summary`, `fields`, `nextSteps`, `forensics`. For info / warning / precondition surfaces in other views, use `Card` (tone `info` / `warning` / `error` / `success`) or `EmptyState`. |
| `NextStepList`   | Renders "what to do next" rows (`<key> → <label> (<detail>)`) from `buildNextSteps` (`ui/shared/next-steps.ts`). One renderer for all three surfaces — the settled `ResultCard`, Home's sprint card, the Flows orientation card. Never re-derive the wording in a view.                                       |
| `WindowedList`   | Universal windowed-list primitive (`windowed-list.tsx`). Id-based cursor, arrows-primary navigation, `▴/▾` overflow cues. **Use this for every long, scrollable, homogeneous list** — replaces the deleted `CardList` and `ListView`.                                                                         |
| `ListCard`       | Shared frame for cards in a vertical list (tickets, tasks); thin wrapper over `Card`.                                                                                                                                                                                                                         |
| `FieldList`      | Aligned `[label, value]` rows. Used inside cards and detail views.                                                                                                                                                                                                                                            |
| `StatusChip`     | `[DRAFT]` / `[ACTIVE]` / `[REVIEW]` / `[DONE]` bracketed tag.                                                                                                                                                                                                                                                 |
| `Spinner`        | Braille-frame loading indicator with trailing label.                                                                                                                                                                                                                                                          |
| `EmptyState`     | "Nothing here yet" surface with optional next-step pointer.                                                                                                                                                                                                                                                   |
| `OverflowRow`    | `▴ N more` / `▾ N more` cue row emitted by `WindowedList` when items are clipped above or below the visible window. Optional `label` overrides the trailing word (default `more`) for a caller with its own copy.                                                                                             |
| `AsyncListFrame` | Owns the `overlay → loading → error → empty → children` ladder for a `useAsyncLoad`-backed view (`async-list-frame.tsx`). Reuses `LoadingRow` / `LoadErrorRow`; pass an `EmptyState` as `empty`. Consumer: the context switcher (`ContextSwitcher`).                                                          |
| `Divider`        | Horizontal rule.                                                                                                                                                                                                                                                                                              |
| `ScrollRegion`   | Scrollable viewport; PgUp/PgDn, Ctrl+f/b/d/u, Home/End (no `g`/`G`). Paints dim `▴ N more` / `▾ N more` rows outside the clip whenever content overflows, so clipping is never silent.                                                                                                                        |
| `PipelineMap`    | Home phase map (refine → plan → implement → close).                                                                                                                                                                                                                                                           |
| `SprintPipeline` | Sprint-detail kanban-style summary.                                                                                                                                                                                                                                                                           |
| `ActionMenu`     | Home action menu + submenus. Items built by `home-internals/menu-items.ts` (`buildMenuItems`).                                                                                                                                                                                                                |

### 4.3 Execute-view family

Specialised components owned by `ExecuteView`. Don't import them from other views.

| Component               | Purpose                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `StepTrace`             | Outer chain trace list. Filters out per-task entries.                                                                         |
| `TasksPanel`            | Dependency-aware per-task card list. Status pill + activity. Cards collapsed by default; `j`/`k` nav, `Enter`/`Space` expand. |
| `RecentEventsTail`      | Rolling log-tail panel. Receives pre-filtered `LogEvent[]` as a prop.                                                         |
| `TokenBudgetCard`       | Subscribes to `TokenUsageEvent`; renders `(input + output) / contextWindow` progress bar.                                     |
| `BaselineHealthCard`    | Renders `SprintExecution.setupRanAt` history in the context column.                                                           |
| `BaselineHealthChip`    | Inline status chip summarising the latest setup-script outcome per repo.                                                      |
| `StatusBanner`          | Tiered `info` / `warn` / `error` banner driven by `BannerShowEvent` / `BannerClearEvent`. Replaces `RateLimitBanner`.         |
| `MultiFlowStrip`        | Horizontal strip listing concurrent session statuses above the tasks panel.                                                   |
| `EvaluatorFailurePanel` | Per-dimension evaluator verdict, parsed from the attempt's `evaluation.md`. Renders inside `EvaluationOverlay`.               |
| `ProgressOverlay`       | Full-screen overlay (`g`) that reads `progress.md` from disk on open; no live tail.                                           |
| `EvaluationOverlay`     | Full-screen overlay (`v`) that reads the focused task's `evaluation.md` on open. Degrades to the one-line verdict.            |
| `CancelScopeOverlay`    | Modal picker (`c`) offering cancel-attempt vs cancel-flow choices.                                                            |

### 4.4 Prompt family (`src/application/ui/tui/prompts/`)

Two legitimate integration modes — pick by who's asking:

- **Business-flow prompts** (a chain leaf / use case needs to ask the user something,
  provider-agnostic). Never build a new prompt component for this — call the injected
  `InteractivePrompt` port and let `createInkInteractivePrompt` queue it onto the `PromptQueue`
  rendered by `PromptHost`.
- **View-local ephemeral prompts** (a browse/action view needs a quick confirm or multi-select
  before an in-view mutation — no chain involved). Mount the prompt **component** directly in the
  view's own conditional render, driven by local React state, exactly like `<ConfirmCard>` /
  `<ConfirmPrompt>` in `sprints-view.tsx` / `sessions-view.tsx`, or `<MultiSelectPrompt>` in
  `skills-view.tsx`'s enable/disable flow picker. The view must `ui.claimPrompt()` for as long as
  the component is mounted (`ConfirmCard` does this internally; a raw `MultiSelectPrompt` mount
  does not — claim it yourself in a `useEffect`) so global hotkeys stay muted underneath it.

| Method           | Returns                             | Cancel behavior                            |
| ---------------- | ----------------------------------- | ------------------------------------------ |
| `askChoice`      | `Result<T, DomainError>`            | Result.error(AbortError) when queue drains |
| `askConfirm`     | `Result<boolean, DomainError>`      | Result.error(AbortError) when queue drains |
| `askText`        | `Result<string, DomainError>`       | Result.error(AbortError) when queue drains |
| `askTextArea`    | `Result<string, DomainError>`       | Result.error(AbortError) when queue drains |
| `askMultiChoice` | `Result<readonly T[], DomainError>` | Result.error(AbortError) when queue drains |

There is no file-browser or single-`editor` method on the port; the path-picker and multi-line text-area are
renderer components selected by prompt `kind` (`text` / `textarea` / `confirm` / `choice` / `multi-choice`).

`askTextArea` is the Claude-style multi-line inline editor (↵ submits; `\↵` or ctrl+j inserts a newline; Esc
cancels). No external editor spawn.

`<MultiSelectPrompt>` (used both by `askMultiChoice`'s queue path and view-local mounts) supports
`Choice.disabled` (dims the row, skips it on cursor movement and `a` select-all, rejects a direct
toggle — same contract as `<SelectPrompt>`'s single-select cursor) and an optional
`initialSelectedValues` prop to pre-check a starting selection (e.g. a skill's `recommendedFor`
list) instead of forcing every choice from scratch.

## 5. State surfaces — one visual per kind

Pick the right surface for the state. Don't mix raw `<Text color={inkColors.error}>…</Text>` with `ResultCard`.

| State                   | Surface                                                                             | Notes                                                 |
| ----------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Loading / running       | `<Spinner label="…" />`                                                             | Info color default. Never bare text.                  |
| Empty (no data)         | `<EmptyState>` or `<Card tone="info" />`                                            | "No X yet" + next-step pointer.                       |
| Precondition failed     | `<Card tone="warning" />`                                                           | "Needs Y first" + next-step pointer.                  |
| Error                   | `<Card tone="error" />`                                                             | One-line message. No stack dumps in user-facing copy. |
| Success / terminal done | `<Card tone="success" />` (or the Execute footer's `<ResultCard kind="success" />`) | fields + next steps.                                  |
| Idle (waiting on input) | the prompt itself                                                                   | Don't render a spinner while a prompt is up.          |

### 5.1 Blocked tasks

A `blocked` task is error-level, never the muted grey a `pending` / `skipped` task gets — a dependency
gate or a self-block still needs the operator's attention, so it must never read as "just hasn't run
yet". Every surface that renders a task's own status agrees on `inkColors.error`:
`STATUS_PRESENTATION.blocked` (the Tasks-panel card header — `task-card-parts.tsx`),
`TASK_STATUS_COLOR.blocked` (the Execute-view sidebar's passive task-nav minimap —
`implement-sidebar.tsx`), and `taskStatusKind('blocked')` (`status-chip.tsx`, the generic
`StatusChip` used wherever a task status renders as a bracketed tag). The glyph is
`glyphFor('blocked')` (△, U+25B3) — the same triangle already reserved for the harness `blocked`
signal kind, reused verbatim on the status card and the sidebar minimap so a blocked row never
reads as an ordinary skip (`phaseDisabled ◌`) or pending (`phasePending ◇`) row.

Rollup counts (Home's hero card, the Sprints-list row) render as a trailing `N blocked` — a bold
`inkColors.error` count + a dim label, appended after the existing `pending` / `approved` sub-counts
with the same bullet-separated, iconless shape those already use. Don't prefix it with
`glyphs.warningGlyph` or any other icon — the count + color carries the state on its own, matching how
`pending` / `approved` render right next to it. Two exceptions: Sprint-detail's own `Tasks` field is a plain
`FieldList` value (`N  (M done · K blocked)`, default weight, no color) rather than a rollup badge; and the
context switcher's sprint row (§ 6.2a) renders `⚠ N blocked` in warning tone — that row is a flat
`name · [STATUS] · current` line with no sub-counts to match, and the `⚠` is what keeps the badge findable
while scanning a long cross-project list.

The card's `blockedReason` (first line, `⚠` icon, warning tone) renders whether the card is collapsed
or expanded — it's the headline fact. When the block came from a generator `task-blocked` signal that
supplied its own structured triage (`BlockedTask.blockerClass` / `.question` / `.whatUnblocksMe`), the
EXPANDED card additionally shows the concrete question (`?` icon, dim tone) and what would unblock it
(`→` icon, dim tone) — supplementary elaboration, not the headline, so they don't clutter the collapsed
one-liner.

**Chords.** `u` unblocks the focused card's stuck task, on both the Execute-view Tasks panel (settled
runs only — see [§6.2](#62-execute-view-keys--active-when-execute-view-owns-the-focus)) and the
sprint-detail task list (no such gate — it's a browse view, never a live run). Sprint-detail also binds
`B` (jump to the next blocked task, wrapping) so an operator doesn't have to arrow-key past a long task
list to reach a row the header already flagged; its footer hint reads `u unblock` / `B next blocked`,
both gated on a blocked task actually existing. Sprint-detail also binds `r` (always available, mirroring
the Sprints list) to re-read the sprint bundle from disk: this view never polls, so an out-of-process
mutation — `ralphctl sprint reopen <id>` run from another terminal, say — stays invisible here until `r`
re-fetches it. The chord has no footer hint (the strip is already near its 100-column budget when `u` and
`B` show); the help overlay lists it, and the one toast that needs it names it. When an unblock's own sprint reopen is refused (another sprint of the project already holds
it) or stalls short of `active`, the `u` toast's retry clause names the fix in order: run
`ralphctl sprint reopen <id>`, press `r` to reload, then `u` again — the Sprints list's bulk `u` mirrors
the same clause (`unblock-feedback.ts`).

**Anchoring.** Once a run settles (no task left in flight), the Tasks panel's card cursor — and with
it the windowed list's visible slice — anchors on the FIRST `blocked` task instead of unconditionally
the last one. Without this, a task blocked early in a long list would fall behind a dim "N more above"
cue the instant the run finished, exactly the failure mode a blocked task's added attention-color exists
to prevent. The same fallback seeds which card auto-expands as the settled summary. Only when nothing
is blocked does the cursor fall through to the last card (unchanged pre-existing behaviour).

**Reconciling a live trace against the polled entity.** The Execute view's bucketed trace and the polled
task list can disagree for two reasons, both corrected wherever a bucket drives a status-sensitive
surface (a card glyph, a done/total count, the sidebar minimap): an own-failure block renders `pending`
once `u` revives the task with an empty attempt ledger and an archived `retiredAttempts` entry to show
for it, and a CASCADE-cleared dependent — blocked only because its prerequisite never finished — also
renders `pending` once `u` on the root clears it back to `todo`, even though a pure dependent archives
no `retiredAttempts` (it never ran an attempt of its own). The cascade-clear correction applies only
once the producing run has settled; while a run is still live, a `todo` snapshot there is
indistinguishable from the dependency gate's own in-flight block not yet reaching the next poll. The
revived-root correction has no such gate — it fires live-run or not, since unblocking (Sprint-detail's
`u` is never gated on run liveness) can happen while other tasks in the same run are still executing,
e.g. after `D` (Detach) backgrounds a run whose own-failure block already settled that task's trace.

## 6. Navigation contract

### 6.1 Sections and global keys — owned by the router

The app has **five persistent sections**, reached with one key each and shown in the tab bar:

| Key | Section  | Root view  |
| --- | -------- | ---------- |
| `1` | Work     | `home`     |
| `2` | Sprints  | `sprints`  |
| `3` | Projects | `projects` |
| `4` | Runs     | `sessions` |
| `5` | System   | `system`   |

`sectionOf(viewId)` (`runtime/nav-tree.ts`) says which section a view belongs to (`welcome` → none). The
router keeps **one stack per section**: `push` / `pop` / `replace` / `reset` act on the active stack and
`goSection(id)` switches, restoring the stack the section was left with (so `5 → Enter → 2 → 5` returns to
`System › Settings`). Pressing the digit of the section you are already in resets it to its root.

**`esc` goes up one level in the current section.** At a section root other than Work it jumps to Work (the
footer says `esc work`); at the Work root it is a no-op. A flow launched from Work lands on the Work stack, so
`esc` returns to Work. The location line shows where you are in that stack — never the path you happened to
take through other sections.

Digits are ignored while a prompt is claimed, while any overlay is open, while a view or overlay claims the
digit (the cancel-scope overlay claims `1` / `2`), and in the first-run wizard.

| Key                 | Action                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| `1`–`5`             | Jump to Work / Sprints / Projects / Runs / System                              |
| `Esc`               | Up one level; at a non-Work section root, to Work; no-op at the Work root      |
| `Tab` / `Shift+Tab` | Cycle running flow (next / prev) — lands in Runs                               |
| `Ctrl+1..9`         | Jump to running flow (Nth running session) — lands in Runs                     |
| `g`                 | Progress overlay (reads `progress.md` from disk)                               |
| `S` / `P`           | Context switcher on the sprint rows / on the current project's header (§ 6.2a) |
| `?`                 | Help overlay (scoped to the current view)                                      |
| `q`                 | Quit (Work root only)                                                          |

**Hidden accelerators.** `h` (Work root), `n` (Work › Flows), `x` (Runs), `s` (System › Settings), `!`
(System › Doctor) keep working from anywhere, land on an explicit destination via `reset`, and yield to a
view that claims the letter. They are listed under Global in `?` help and **never advertised in the
footer** — the tab bar teaches the five sections. `b` is not global: Home binds it as `b banner`.

Switch between running flows via `Tab` / `Shift+Tab` (cycle next / prev) or `Ctrl+1..9` (jump to the Nth
running session); the Runs section (`4`) lists them all. Both chords cycle / jump over RUNNING sessions
only and are suspended while a prompt or overlay is mounted.

### 6.1a Footer hint strip

The footer is a rule plus exactly ONE hint row (nothing above it — health and counts are tab badges): a single `<Text wrap="truncate-end">` built from
`fitHints(hints, columns − 2·spacing.indent)` (`components/hint-budget.ts`, pure). A cell is
`<keys> <label>`, cells join with `·`, width counts code points. Priority order: view-local hints
(declared order), then the globals `buildFooterGlobalHints` derives from where you are: `esc <parent>`
(only when `esc` does something — `esc Sprints` deeper in a stack, `esc work` at another section root),
`1–5 sections` (only from `lg`), `? help`, `q/ctrl+c quit` (only on the Work root). The single-letter
accelerators are never listed. The first hint that does not fit
ends the run, and a trailing `… ? more` cell is reserved whenever anything is dropped — a
low-priority hint never survives a higher one. Honesty rules: `esc` is omitted at the Work
root (a no-op there); `q` is omitted everywhere it does not quit; while a prompt holds `claimPrompt` the
strip shows only the view-local hints plus `ctrl+c quit`, because every global letter is muted.

Layout tests that depend on terminal width use `renderAtSize(node, { columns, rows })` from
`tests/helpers/render-at-size.tsx`; `ink-testing-library` is pinned to 100 columns.

### 6.2 Execute-view keys — active when Execute view owns the focus

| Key               | Action                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------- |
| `j` / `↓`         | Next task card / row                                                                   |
| `k` / `↑`         | Previous task card / row                                                               |
| `Enter` / `Space` | Expand / collapse card or commit row                                                   |
| `Esc`             | Collapse expanded card                                                                 |
| `e`               | Expand done-criteria for the active card                                               |
| `v`               | Open the focused card's evaluation verdict (`evaluation.md`)                           |
| `c`               | Open cancel-scope picker (attempt vs flow)                                             |
| `D`               | Detach (background the flow)                                                           |
| `y`               | Copy the active task's markdown summary (Execute-local; inert everywhere else)         |
| `r`               | Settled run only — reset to Flows so the launch triggers are re-evaluated              |
| `u`               | Settled run only, with a blocked task focused — unblock it ([§5.1](#51-blocked-tasks)) |

`c` / `D` are live only while the chain runs; `r` only once it has settled, so the two sets never
contend. `y` is hinted (`y copy task`) while a task is active and confirms with a short-lived
`Copied to clipboard` banner (stable id, so re-presses replace it); outside Execute it does nothing —
there is no global `y` and no "no active task" toast. A settled run's hint strip reads `↵ home · r re-run · g progress · v evaluation` (`g` is the
global progress-overlay chord — hinted here, handled globally, never bound twice), plus a trailing
`u unblock` once the run left a task blocked. `u` is advertised ONLY in the settled set: the Tasks
panel's own `u` chord is a no-op while a run is live (blocked-task ids are forced empty mid-run — a
polled entity can flip `blocked` while the in-memory run still thinks it owns the task, and honouring
`u` there would race the run's own write), so hinting it during a run would advertise a key whose
handler rejects every press — the thing the hint-strip invariant in
[§6.3](#63-view-local-keys--declared-once-via-useviewkeys) forbids.

`v` is hinted on both halves (a failed round mid-run is exactly when the critique is wanted) and gated
on some task having recorded a verdict. OPENING is view-local — only a view knows which card the cursor
is on — while CLOSING (`Esc` / `v`) is global, so it wins over the hidden view underneath. Sprint-detail
binds the same `v` on a focused task row; the two surfaces are never mounted at once.

### 6.2a Context switcher keys — active when the `S` / `P` overlay is open

One overlay replaces the old pick-project and pick-sprint screens. `S` opens it with the cursor on the current
sprint, `P` with the cursor on the current project's header. It **never navigates**: `↵` switches the selection
and closes, `esc` closes, and `router.stack` is untouched either way — the view underneath stays mounted
(hidden) with its cursor and scroll intact.

| Key       | Action                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------- |
| `↑` / `↓` | Move (`j` / `k` aliases) — over the create row, project headers and sprint rows                   |
| `↵`       | Sprint → `setProjectAndSprint`; project header → `setProject` (clears the sprint when it changes) |
| `c`       | New sprint in the current project (`+ New sprint in <project>` row) — closes, then launches       |
| `t`       | Toggle scope — all projects ↔ current project only                                                |
| `f`       | Toggle hide-done — hide / show `done` sprints                                                     |
| `esc`     | Close                                                                                             |

Rows: a `+ New sprint in <project>` row (only with a current project), then each project as a selectable
header — `<NAME> · N repo(s)` with `↵ switch project` on the right, or `no sprints · ↵ switch` — followed by
its sprints (name, status chip, `current`, `⚠ N blocked`). Sprints whose project was deleted group under a
non-selectable `⚠ UNKNOWN PROJECT` header. Width: full width below `md`; `min(96, columns − 4)` from `md`,
left-aligned at the page indent. The tab bar and location line stay above it; the overlay pins its own
rule + hint row. It lives in `ui.overlay` as `{ kind: 'switcher'; focus: 'sprint' | 'project' }`, so `?`
replaces it and the global handler swallows every other key while it is open. `t` / `f` are registered in
`keyboard-map.ts` as `switcherKeys`; new switcher keys follow the same pattern.

### 6.3 View-local keys — declared once via `useViewKeys`

A view declares its local keys ONE time. `useViewKeys` mounts the `useInput` dispatcher and feeds
the status-bar hint strip from the same array, so a key can never be advertised as live while its
handler rejects it.

```tsx
useViewKeys(
  [
    { keys: ['↑', '↓', 'j', 'k'], hint: 'move' }, // no `run` — the list primitive owns these
    { keys: ['↵'], hint: 'open' },
    { keys: ['b'], hint: 'browse', run: () => browse(focused) },
    { keys: ['u'], hint: `unblock (${String(stuckCount)})`, enabled: stuckCount > 0 },
  ],
  { active: !modalOpen }
);
```

- `keys` are the literal input strings the binding claims, and (joined by `/`) its status-bar
  spelling. Omit `run` for an entry that only documents a key another primitive owns.
- `enabled: false` mutes the handler AND drops the hint — for a key that genuinely does nothing
  in the current state.
- `hidden: true` drops the hint but keeps the handler — for a key that IS inert but whose handler
  exists to say why (a silent swallow reads as a bug to anyone who found the key in `?`).
- `active: false` mutes the whole dispatcher while a modal / confirm overlay owns the keyboard;
  hints are unaffected, so the strip keeps describing the screen underneath. An open app overlay
  (help / progress / evaluation) mutes every dispatcher automatically.
- Special keys are spelled as their hint glyphs and match the real key: `↵`, `esc`, `Tab`, `↑`, `↓`,
  `←`, `→`, `PgUp`, `PgDn`, `Home`, `End`. Everything else matches the literal input character.
- Two helpers in `keyboard-map.ts` keep the vocabulary identical across views: `listMoveBinding`
  (the documentation-only `↑/↓ move`) and `createBindings(run)` (`c create` with `+` as a silent
  alias — `n` is never "create", it opens Flows).

Views never call `useViewHints` directly — a source grep fails the suite if one does. A second,
hand-synced hint array is how footers and handlers drifted. A view subtitle describes the screen
(`scoped to current project`, the active Settings section); it never repeats a key hint.

Canonical vocabulary — reuse these spellings so users build one mental model:

| Key                                | Action                                |
| ---------------------------------- | ------------------------------------- |
| `↑/↓`                              | move cursor                           |
| `←/→`                              | switch panes / prev/next page         |
| `Enter`                            | confirm / open / run                  |
| `Space`                            | toggle / multi-select                 |
| `Tab` / `Shift+Tab`                | next / prev field                     |
| `↵` / `\↵`                         | submit / newline in multi-line editor |
| a single letter (`b`, `r`, `n`, …) | the view's primary action             |

Rules:

- **Any undocumented key is a bug.** If a view responds to it, hint for it — with `useViewKeys`
  the two come from the same entry, so the only way to break this is `hidden: true`, which owes a
  comment naming the reason.
- `Enter` on a terminal/result state pops the view.
- `Esc` inside a submode returns to the parent mode before being claimed by the router.

### 6.4 Windowed-list navigation contract

Every long, scrollable, homogeneous item list mounts through the windowed-list primitive
(`src/application/ui/tui/components/windowed-list.tsx` — `computeListWindow` / `useListWindow` /
`WindowedList` / `OverflowRow`). The primitive owns the cursor and the keyboard so navigation is
identical on every list surface. The map of record is `listKeys` in `keyboard-map.ts`.

**Four key groups** (all handled by `useListWindow`, gated by its `active` flag):

| Group          | Keys            | Action                |
| -------------- | --------------- | --------------------- |
| Move (primary) | `↑` / `↓`       | move cursor one row   |
| Move (alias)   | `j` / `k`       | move cursor one row   |
| Page           | `PgUp` / `PgDn` | move by `visibleRows` |
| Jump           | `Home` / `End`  | first / last item     |

`↵` (Enter / Return) submits the focused item. `g`/`G` vim aliases are absent from `useListWindow` — `g` is bound globally to the progress overlay and would double-fire on list surfaces; `Home`/`End` cover the same ground without the conflict.

**Arrows are primary; `j`/`k` are a global alias.** Advertise `↑/↓` with `listMoveBinding` when
the view shows a nav hint. **Do not list `j`/`k` (or `PgUp`/`PgDn` / `Home`/`End`) in per-view hints**
— they apply to every list and are documented once in the help overlay's `Lists` section (generated
from `listKeys`). A per-view hint strip names only the view's own keys plus the primary `↑/↓` move.

**Canonical `useViewKeys` spellings.** Reuse the [§6.3](#63-view-local-keys--declared-once-via-useviewkeys)
vocabulary: `↑/↓` → `move`, `Enter` → `open` / `confirm` / `run`. Inline-detail lists use
`Enter` → `expand/collapse` ([§7.2](#72-list-views)).

**Overflow-row rule.** When the list is taller than the viewport, `OverflowRow` renders a dim
`▴ N more` cue above the window and a `▾ N more` cue below it (`glyphs.moreAbove` / `glyphs.moreBelow`).
Never render a list longer than its window — the primitive slices before `.map()` by construction,
satisfying the [§7.6](#76-render-caps-for-list-data) cap.

**Id-based cursor rule.** `useListWindow` stores the cursor as the focused item's **id** (via the
required `getId` prop), not its index. A reorder or eviction keeps focus on the same logical item —
or snaps to the nearest survivor by prior index — instead of teleporting to whatever now sits at the
old index. Always pass a stable id; never re-key a windowed list by array index.

**`suppressScrollArrows` rule.** A view that owns a list cursor AND whose content can exceed the
viewport must pass `suppressScrollArrows` to its `ViewShell` so the page-level `ScrollRegion` does
not double-handle `↑/↓` / `PgUp`/`PgDn`. The list cursor wins; the page scroll yields. Views without
a list cursor leave `ScrollRegion` to handle arrows normally.

**Cursor-stays-visible rule.** A list row holding the cursor registers `useScrollAnchor(focused)`
(`ActionMenu` does it for its focused row), so the region scrolls to keep it on screen even when the
arrows are suppressed. A new anchor re-runs the region's reveal pass itself — the cursor state may live
in a descendant that never re-renders the region. `ActionMenu` also honours `visibleRows`; Home passes
`listCapacity(rows, …)`.

**Doctor ordering.** Doctor lists groups worst-first (fail, warn, unknown, pass). All-pass groups collapse
into a single `✓ N passed` line that `↵` expands; the provider-binary probe reports `pass` for a CLI that is
missing but unreferenced by `settings.ai`, so the doctor nag only names things the operator actually uses.

### 6.5 Keyboard ownership — one owner per keystroke

Ink fans every keystroke out to every mounted `useInput`, so a key bound both by the active view and
by an ambient handler fires twice. Ownership is explicit:

- **Claimed keys.** `ClaimedKeysProvider` (`runtime/claimed-keys-context.tsx`, mounted in `App.tsx`)
  is a counter-per-key registry read at keypress time. `useViewKeys` claims every enabled, printable
  binding that has a `run`; an overlay that uses keys without `useViewKeys` calls `useClaimKeys`
  (the cancel-scope overlay claims `1` / `2`). `useGlobalKeys` (the section digits, the accelerator letters and `g`)
  and `StatusBanner` (`d` dismiss) ask `isClaimed(input)` and stand down — so project-detail's `S`
  (detect skills) never also opens the switcher, a list's `d` (delete) never also dismisses a
  banner, and section digits never fire under a view or overlay that uses them. The banner also stops
  advertising `(press d to dismiss)` while `d` is claimed. `?`, `Ctrl+C` and `esc` are not claimable;
  `esc` has its own `claimEscape` counter.
- **One overlay slot.** `ui.overlay` is `{ kind: 'help' } | { kind: 'switcher'; focus } | { kind: 'progress' } | { kind: 'evaluation';
target } | undefined`, with `openOverlay` / `closeOverlay`. Opening replaces whatever is open;
  `helpOpen`, `switcherFocus`, `progressOpen` and `evaluationTarget` are derived read-only views of it and
  `toggleHelp` / `toggleProgress` / `closeEvaluation` are thin wrappers. `modalOpen` is
  `overlay !== undefined || promptActive`.
- **Overlays mount in the Layout, never in a view.** `HelpOverlay`, `ContextSwitcher`, `ProgressOverlay` and
  `EvaluationOverlay` mount beside each other in `App.tsx`; the active view stays mounted under
  `display: none`, so its hints, cursor and scroll offset survive. No view branches on `helpOpen`.
- **Context-aware help.** The overlay shows `This view` (the live hints), `Global`, the general
  sections (`Lists`, `Scroll`, `Contextual`) and only the route-bound sections of surfaces mounted on
  the current route (`KeySection.onlyOn`: `Execute` / `Tasks panel` / `Signals` on `execute`; the `Context switcher` keys, an
  overlay rather than a route, appear under `All keys`). `Tab` toggles `All keys`.
- **Ambient vs local.** The section digits and the accelerator letters (`h n x s ! S P g`) yield to a
  claiming view. A view that owns a letter AND needs its global meaning does both itself (sprint-detail's
  `n` reseats the selection, then pushes Flows) — never rely on two handlers composing.

### 6.6 Scroll

`ScrollRegion` (the middle slot of every view) scrolls on `PgUp` / `PgDn` / `Ctrl+b` / `Ctrl+f` (page),
`Ctrl+u` / `Ctrl+d` (half page), `Home` / `End` (ends) and the mouse wheel; arrows also scroll when a view
has no cursor. A view that owns a cursor (a list, a field cursor) passes `suppressScrollArrows` and
registers the focused row with `useScrollAnchor` so the page follows the cursor — Settings (the focused
field value) and project-detail (the focused repo card / project card) do exactly this, like the list
views. The `Scroll` section of the help overlay is generated from `scrollKeys`.

## 7. View patterns

Each view type has one shape. Don't invent a new one.

### 7.1 Workflow views (create / edit / remove / configure)

```tsx
<ViewShell title="CREATE SPRINT">
  {phase.kind === 'running' && <Spinner label={phase.label} />}
  {phase.kind === 'done' && <Card tone="success" …/>}
  {phase.kind === 'error' && <Card tone="error" …/>}
</ViewShell>
```

Reserve `<ResultCard kind="success|failed|aborted" />` for chain-settlement footers; ordinary views terminate
with `Card`.

- Drive phase state from local React state or `useReducer`.
- `phase.step` drives the spinner label — set it before each prompt.
- `Enter` on a terminal outcome card pops the view.

### 7.2 List views

- `WindowedList` (via `useListWindow` + `WindowedList`) with `↑/↓ · Enter open · Esc back`. See [§6.4](#64-windowed-list-navigation-contract) for the full key contract.
- Empty state → `EmptyState` or `Card tone="info"` with a next-step pointer.

**Inline-detail toggle variant.** For lists where the parent is short and the detail content fits below in
5–10 rows (today: ticket-list, task-list), `Enter` is allowed to toggle an inline detail card beneath the
highlighted row instead of pushing a separate show view. This keeps the user in one frame and removes a Back
step. When using this variant:

- The view-local hint MUST read `Enter expand/collapse` (not `Enter view detail`).
- Pressing `Enter` a second time on the same row collapses; moving the cursor while
  expanded collapses the previous and expands the new selection.
- Use a `<FieldList>` for the detail body so it visually matches the show-view shape.

For lists with long detail content or where the detail view itself has actions
(e.g. project-detail with repo CRUD), use the standard drill-in pattern (Enter
pushes a dedicated `*-detail-view.tsx`).

### 7.3 Detail views

- `FieldList` for metadata.
- `StatusChip` for lifecycle state.
- Detail views are primarily read-only browse surfaces. An explicit `m` chord is allowed to make the viewed entity current when opening the detail must not implicitly switch the selection (e.g. `ProjectsView` and `ProjectDetailView` — browsing must not clear the sprint cursor as a side effect).
- **Execute view is the one deliberate exception.** Focusing a session (Tab / Ctrl+1..9 / Sessions-open) auto-converges the global selection onto that run's pinned sprint — unlike Projects/Sprint-detail browsing, this view IS the thing currently being worked, so `n → Flows` must target what's on screen, not a stale pick from before the focus switch. The convergence is non-persisting (an exploratory Tab-cycle through old sessions must never corrupt the next boot's default sprint — see `selection-context.tsx`'s `followFocusedRun`) and fires the "✓ now on …" toast so the switch is visible, never silent.

### 7.4 Phase views (refine / plan / implement / review)

- Behave like a workflow view: a `ViewShell` title, phase state, an outcome card for the terminal state.
- No bespoke input handlers — everything goes through the injected `InteractivePrompt` port.

### 7.5 Settings view — section tabs

`SettingsView` is the only configuration surface dense enough to need an in-view nav primitive.
It uses a **segmented section strip** (text tabs, no chrome) along the top: `← / →` cycle
sections; `↑ / ↓` navigate fields inside the active section; `↵ / e` opens the editor for the
focused field. Only one section's fields render at a time. The view subtitle names the active section;
the keys live only in the footer strip. `[` / `]` are not bound. The view passes `suppressScrollArrows`
and anchors the focused field value (§ 6.6).

**Why tabs over collapsible cards or a two-pane split.** A flat scroll listed ~30 editable rows
in one column; the cursor path from the first preset button to the last harness budget was a
keypress-counting exercise. Three candidate fixes:

- **Collapsible cards** (one expanded at a time) — saves vertical space but keeps every label
  on screen and still requires the user to land on the right header before the editable rows
  appear. The collapsed strip is busier than a tab row.
- **Two-pane layout** (left section list, right active section body) — clean at wide widths but
  forces a `←/→` pane-switch idiom that fights every other list view in the app (where `←/→`
  pages or does nothing) and degrades to a single-column stack below ~140 cols anyway.
- **Section tabs** — one horizontal strip, one body card below it. Discoverable (every section
  label is always on screen), bounded (the per-section row count is the per-section keypress
  budget), and the `←/→` idiom matches the canonical "prev/next page" vocabulary in
  [§6.3](#63-view-local-keys--declared-once-via-useviewkeys).

Per-section row counts: `Presets 22`, `Global 1`, `Refine 3`, `Plan 3`,
`Implement 6` (generator triple + evaluator triple), `Readiness 3`, `Ideate 3`, `Create-PR 3`,
`Harness 8` (seven scalar/select rows + one `map-add` action row; grows by one `map-entry` row per
user-defined escalation-map override), `Other 2`, `Storage 0` (read-only). Presets is the largest
section; among the rest, Implement is the largest at 6 rows.

**Responsive fallback.** The section strip uses `flexWrap="wrap"`, so on terminals narrower
than the strip's natural width (the default 11 labels) the strip wraps onto a
second row. The body card below the strip is a stock `<Card>` — it follows the same
single-column layout at every breakpoint, since the per-section field lists are short enough
that wrapping was never the bottleneck. No special handling at `sm` is needed beyond the strip
wrap; the active-section glyph (`▸`) keeps the focused label identifiable even when wrapped.

**Model field is catalog-only.** The per-flow model row mounts a `SelectPrompt` populated from
the active provider's catalog. There is no "+ custom" / free-text affordance; pinning to an
off-catalog model is done by editing the settings file directly (or via `ralphctl settings set
ai.<flow>.model <id>`). The read side still shows whatever is persisted — an off-catalog model
remains visible on screen until the user picks a catalog entry to overwrite it.

### 7.6 Render caps for list data

Every list rendered from chain trace, event-bus, or harness-signal data MUST `.slice(-max)` before `.map()` to JSX, with
an elision row above the rendered tail when truncated. Exception: lists with a hard domain bound (legend entries,
settings options, fixed phase order) may render in full — comment the bound at the call site.

Spinner state lives in the leaf `<Spinner />` component (`src/application/ui/tui/components/spinner.tsx`). Don't call
`useSpinnerFrame` from a component that renders a subtree larger than itself — the 90 ms re-render propagates. Use
`<Spinner active … />` instead.

## 8. Copy & tone

### 8.1 Spinner labels

Imperative, present-continuous, one trailing ellipsis. Describe what **the harness** is doing, not what the
user is about to do.

| ✅                     | ❌                                             |
| ---------------------- | ---------------------------------------------- |
| `Loading sprints…`     | `Waiting for sprints…`                         |
| `Saving ticket…`       | `Ticket save in progress…`                     |
| `Fetching issue data…` | `Downloading issue data…`                      |
| `Generating tasks…`    | `AI is thinking…`                              |
|                        | `Type the sprint name…` (that's a prompt hint) |

### 8.2 Empty / error / next-step copy

- **Empty:** state the absence, then the next step. `No sprints yet.` + `Open Sprints ▸ Create sprint.`
- **Error:** state what failed, then what the user can do. Avoid stack traces in the card body.
- **Next step:** single-verb imperative. `Approve requirements.` `Confirm task list.`

### 8.3 Status words

Use one spelling everywhere. `DRAFT`, `PLANNED`, `ACTIVE`, `REVIEW`, `DONE`, `TODO`, `IN PROGRESS`, `BLOCKED`,
`FAILED`. No mixed case (`In Progress`, `in progress`). No synonyms (`complete` vs `done`).

## 9. Anti-patterns (non-negotiables)

- ❌ Hardcoded hex — always `inkColors.*`.
- ❌ Inline unicode glyph — always `glyphs.*`.
- ❌ Magic spacing number — always `spacing.*`.
- ❌ Raw emoji inside an Ink view.
- ❌ View renders its own header / title row / hint strip / status bar.
- ❌ Advertising `h n x s ! S P` in a footer or hint strip — the tab bar teaches the sections; the letters are hidden accelerators.
- ❌ View calls `console.log` / writes stdout directly — use the injected `Logger`.
- ❌ View calls a use case directly — use flow factories from `src/application/flows/<flow>/` and the chain runner.
  **Escape hatch:** a single-shot mutation with no registered flow (manual task unblock, cancel the
  active task, launch a flow session) goes through a runtime hook under
  `src/application/ui/tui/runtime/` — `useUnblockTask`, `useLaunchCreateSprint`. The hook closes over
  `useDeps()` and assembles the use-case argument once; the view supplies only what it knows and never
  names a use case or reaches into `AppDeps`. Reach for this only when there is genuinely no chain to
  run — inventing a one-leaf chain to satisfy the layering buys nothing. Anything with steps, prompts,
  or a trace is a flow.
- ❌ View mounts a prompt outside the injected `InteractivePrompt` port.
- ❌ Mixing `<Text color={inkColors.error}>` with `ResultCard` in the same state.
- ❌ New prompt component — reuse the `InteractivePrompt` port + `createInkInteractivePrompt`.
- ❌ Barrel `index.ts` files — every import points to its source module.

## 10. When to extend vs. reuse

Before adding anything new, work this ladder top-down:

1. **Does a token cover it?** Add color/glyph/spacing via `tokens.ts`, not ad-hoc.
2. **Does an existing component render it?** `ResultCard` + `FieldList` + `StatusChip` + `Spinner` handle ~80% of
   states.
3. **Is it a new state surface?** Add a `ResultCard` `kind`, don't build a parallel card.
4. **Is it a new view shape?** Describe it here first (add a § 7 subsection), then build it.
5. **Is it a new prompt kind?** Add a method to the `InteractivePrompt` port + a prompt component under
   `src/application/ui/tui/prompts/`.

If you reach step 4 or 5, open a design note before the PR — this document should change with the code.

## 11. Checklist for new views

Run this before opening a PR on a new TUI surface:

- [ ] Wrapped in `<ViewShell>` (not bare, unless Home).
- [ ] `ViewShell` `title` / `subtitle` name the view (they publish to the location line); the view's section is registered in `nav-tree.ts` `sectionOf`.
- [ ] Every color / glyph / spacing value comes from `tokens.ts`.
- [ ] All interaction is an `InteractivePrompt` call.
- [ ] `useViewKeys([…])` declares every key the view responds to — hint and handler from one entry; no bare `useViewHints`, no `HelpOverlay` mount, no key hint in the subtitle.
- [ ] Loading state uses `<Spinner>`; terminal states use a `Card` (or the Execute footer's `<ResultCard>`).
- [ ] No use-case or adapter imported directly — flow factory or injected port only.
- [ ] A test asserts the happy path renders the terminal outcome card (a `Card tone="success"`, or a chain-settlement
      `ResultCard kind="success"`).
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all green.
