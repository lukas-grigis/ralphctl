# RalphCTL — TUI Design System

The single source of visual truth for the Ink TUI. Every view, prompt, and component follows the tokens,
patterns, and contracts in this document. Before adding a new component or one-off glyph, read this first —
most needs are already covered.

Companion docs:

- [REQUIREMENTS.md § UI Contract](./REQUIREMENTS.md#ui-contract) — the testable acceptance criteria.
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

| Group           | Tokens                                                                   |
| --------------- | ------------------------------------------------------------------------ |
| Phase / status  | `phaseDone ■`, `phaseActive ◆`, `phasePending ◇`, `phaseDisabled ◌`      |
| Cursors         | `actionCursor ▸`, `selectMarker ›`                                       |
| Section markers | `badge ▣`, `sectionRule ━`                                               |
| State           | `check ✓`, `cross ✗`, `warningGlyph ⚠`, `infoGlyph i`                    |
| Bullets         | `bullet ·`, `inlineDot ·`, `emDash —`, `arrowRight →`, `activityArrow ↳` |
| Separators      | `pipe │`                                                                 |
| Motion          | `spinner` (braille frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`)                                  |
| Clip markers    | `clipEllipsis …`, `collapseExpand ▼ more`                                |
| Personality     | `quoteRail ┃`                                                            |

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

Every non-Home view mounts through `<ViewShell>`:

```
┌─ ViewShell ─────────────────────────────────────┐
│  <SectionStamp title="VIEW TITLE" />            │ ← header (always)
│                                                 │
│  <body>  ← the view-specific content            │
│                                                 │
│  <StatusBanner />  ← dismissible banners (auto) │
│                                                 │
│  <PromptHost />  ← inline prompts (auto)        │
└─────────────────────────────────────────────────┘
<StatusBar>  ← owned by the router (breadcrumb + merged KeyboardHints: view-local + global)
```

**Views never render their own header, hint strip, or status bar.** `ViewShell` + router own all three.
Home is the single exception — it renders the Banner + pipeline map instead of a SectionStamp.

## 4. Component inventory

All components live in `src/application/ui/tui/components/`. Use these. Don't write a sibling that does 90% of
the same job.

### 4.1 Shell + chrome

| Component                | Purpose                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `ViewShell`              | Frame for every view. Owns header + body + hints spacing.                             |
| `SectionStamp`           | `▣ VIEW TITLE ━━━…` header. Brand-mustard accent.                                     |
| `Breadcrumb`             | Path strip at the top of `StatusBar`.                                                 |
| `StatusBar`              | Breadcrumb + global hotkey hints. Owned by router. Never from a view.                 |
| `KeyboardHints`          | View-local hotkey strip. Published via `useViewHints([…])`.                           |
| `HelpOverlay`            | Modal `?`-key overlay. Driven by the centralised keyboard map.                        |
| `Banner`                 | Home-only Ralph banner + pipeline map. Do not reuse elsewhere.                        |
| `MemoryPressureBanner`   | Heap-pressure strip mounted at App root. Subscribes to the EventBus.                  |
| `ChainLogDegradedBanner` | Latched warning when the on-disk `chain.log` sink can't keep up. Mounted at App root. |

### 4.2 Content surfaces

| Component        | Purpose                                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Card`           | Bordered content box. Base for ResultCard.                                                                                                                                                                                                                                                       |
| `ResultCard`     | Chain-settlement outcome card for the Execute-view footer: `kind` is `success` / `failed` / `aborted`. Carries `title`, `summary`, `fields`, `nextSteps`. For info / warning / precondition surfaces in other views, use `Card` (tone `info` / `warning` / `error` / `success`) or `EmptyState`. |
| `CardList`       | Vertical stack of cards with consistent spacing.                                                                                                                                                                                                                                                 |
| `ListCard`       | Shared frame for cards in a vertical list (tickets, tasks); thin wrapper over `Card`.                                                                                                                                                                                                            |
| `FieldList`      | Aligned `[label, value]` rows. Used inside cards and detail views.                                                                                                                                                                                                                               |
| `StatusChip`     | `[DRAFT]` / `[ACTIVE]` / `[REVIEW]` / `[DONE]` bracketed tag.                                                                                                                                                                                                                                    |
| `Badge`          | Small inline state label.                                                                                                                                                                                                                                                                        |
| `Spinner`        | Braille-frame loading indicator with trailing label.                                                                                                                                                                                                                                             |
| `EmptyState`     | "Nothing here yet" surface with optional next-step pointer.                                                                                                                                                                                                                                      |
| `ListView`       | Paginated list with `↑/↓` + `Enter`. For browse screens.                                                                                                                                                                                                                                         |
| `Divider`        | Horizontal rule.                                                                                                                                                                                                                                                                                 |
| `ScrollRegion`   | Scrollable viewport with PgUp/PgDn.                                                                                                                                                                                                                                                              |
| `PipelineMap`    | Home phase map (refine → plan → implement → close).                                                                                                                                                                                                                                              |
| `SprintPipeline` | Sprint-detail kanban-style summary.                                                                                                                                                                                                                                                              |
| `ActionMenu`     | Home action menu + submenus. Items built by `home-internals/menu-items.ts` (`buildMenuItems`).                                                                                                                                                                                                   |

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
| `EvaluatorFailurePanel` | Per-dimension evaluator scores with expand affordance. Fixture-gated behind `developer.showEvaluatorFailureUI`.               |
| `ProgressOverlay`       | Full-screen overlay (`g`) that reads `progress.md` from disk on open; no live tail.                                           |
| `CancelScopeOverlay`    | Modal picker (`c`) offering cancel-attempt vs cancel-flow choices.                                                            |

### 4.4 Prompt family (`src/application/ui/tui/prompts/`)

Never build a new prompt component. Always call the injected `InteractivePrompt` port and let
`createInkInteractivePrompt` queue it onto the `PromptQueue` rendered by `PromptHost`.

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

## 6. Navigation contract

### 6.1 Global hotkeys — owned by the router

These work from **every** view. Don't override them.

| Key   | Action                                           |
| ----- | ------------------------------------------------ |
| `Esc` | Pop one frame (no-op at root)                    |
| `h`   | Home                                             |
| `n`   | New flow (flows view)                            |
| `x`   | Sessions view                                    |
| `s`   | Settings                                         |
| `!`   | Doctor                                           |
| `b`   | Toggle banner compact ↔ full                     |
| `g`   | Progress overlay (reads `progress.md` from disk) |
| `y`   | Yank active-task summary to clipboard            |
| `P`   | Open project picker (cross-project)              |
| `S`   | Open sprint picker (cross-project)               |
| `?`   | Help overlay                                     |
| `q`   | Quit (Home root only)                            |

Switch between running flows via the Sessions view (`x`) — there is no Tab / Ctrl+digit flow-cycling chord.

### 6.2 Execute-view keys — active when Execute view owns the focus

| Key               | Action                                     |
| ----------------- | ------------------------------------------ |
| `j` / `↓`         | Next task card / row                       |
| `k` / `↑`         | Previous task card / row                   |
| `Enter` / `Space` | Expand / collapse card or commit row       |
| `Esc`             | Collapse expanded card                     |
| `e`               | Expand done-criteria for the active card   |
| `c`               | Open cancel-scope picker (attempt vs flow) |
| `D`               | Detach (background the flow)               |

### 6.2a Sprint picker keys — active when the `S` picker overlay is open

| Key | Action                                             |
| --- | -------------------------------------------------- |
| `t` | Toggle scope — all projects ↔ current project only |

The picker is opened globally via `S`; `t` is its one view-local key and is registered in `keyboard-map.ts`
alongside the other `pickerKeys`. Any new picker keys follow the same pattern.

### 6.3 View-local keys — published via `useViewHints`

```tsx
useViewHints([
  { key: '↑/↓', action: 'move' },
  { key: 'Enter', action: 'open' },
  { key: 'b', action: 'browse' },
]);
```

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

- **Any undocumented key is a bug.** If a view responds to it, hint for it.
- `Enter` on a terminal/result state pops the view.
- `Esc` inside a submode returns to the parent mode before being claimed by the router.

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

- `ListView` with `↑/↓ · Enter open · Esc back`.
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
- No action verbs — detail views are read-only.

### 7.4 Phase views (refine / plan / implement / review)

- Behave like a workflow view: `SectionStamp`, phase state, an outcome card for the terminal state.
- No bespoke input handlers — everything goes through the injected `InteractivePrompt` port.

### 7.5 Settings view — section tabs

`SettingsView` is the only configuration surface dense enough to need an in-view nav primitive.
It uses a **segmented section strip** (text tabs, no chrome) along the top: `← / →` cycle
sections; `↑ / ↓` navigate fields inside the active section; `↵ / e` opens the editor for the
focused field. Only one section's fields render at a time.

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
  [§6.3](#63-view-local-keys--published-via-useviewhints).

Per-section row counts (all ≤ ~8): `Presets 4`, `Global 1`, `Refine 3`, `Plan 3`, `Implement 6`
(generator triple + evaluator triple), `Readiness 3`, `Ideate 3`, `Create-PR 3`, `Harness 4`, `Other 2`,
`Storage 0` (read-only). Implement is the largest and is the right stress-test for the cap.

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

Every list rendered from chain trace, event-bus, or harness-signal data MUST `.slice(-max)` before `.map()` to JSX, with an elision row above the rendered tail when truncated. Exception: lists with a hard domain bound (legend entries, settings options, fixed phase order) may render in full — comment the bound at the call site.

Spinner state lives in the leaf `<Spinner />` component (`src/application/ui/tui/components/spinner.tsx`). Don't call `useSpinnerFrame` from a component that renders a subtree larger than itself — the 90 ms re-render propagates. Use `<Spinner active … />` instead.

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
- ❌ View renders its own header / hint strip / status bar.
- ❌ View calls `console.log` / writes stdout directly — use the injected `Logger`.
- ❌ View calls a use case directly — use flow factories from `src/application/flows/<flow>/` and the chain runner.
- ❌ View mounts a prompt outside the injected `InteractivePrompt` port.
- ❌ Mixing `<Text color={inkColors.error}>` with `ResultCard` in the same state.
- ❌ New prompt component — reuse the `InteractivePrompt` port + `createInkInteractivePrompt`.
- ❌ Barrel `index.ts` files — every import points to its source module.

## 10. When to extend vs. reuse

Before adding anything new, work this ladder top-down:

1. **Does a token cover it?** Add color/glyph/spacing via `tokens.ts`, not ad-hoc.
2. **Does an existing component render it?** `ResultCard` + `FieldList` + `StatusChip` + `Spinner` handle ~80% of states.
3. **Is it a new state surface?** Add a `ResultCard` `kind`, don't build a parallel card.
4. **Is it a new view shape?** Describe it here first (add a § 7 subsection), then build it.
5. **Is it a new prompt kind?** Add a method to the `InteractivePrompt` port + a prompt component under
   `src/application/ui/tui/prompts/`.

If you reach step 4 or 5, open a design note before the PR — this document should change with the code.

## 11. Checklist for new views

Run this before opening a PR on a new TUI surface:

- [ ] Wrapped in `<ViewShell>` (not bare, unless Home).
- [ ] Title is an ALL-CAPS `SectionStamp`.
- [ ] Every color / glyph / spacing value comes from `tokens.ts`.
- [ ] All interaction is an `InteractivePrompt` call.
- [ ] `useViewHints([…])` lists every key the view responds to.
- [ ] Loading state uses `<Spinner>`; terminal states use a `Card` (or the Execute footer's `<ResultCard>`).
- [ ] No use-case or adapter imported directly — flow factory or injected port only.
- [ ] A test asserts the happy path renders the terminal outcome card (a `Card tone="success"`, or a chain-settlement `ResultCard kind="success"`).
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all green.
