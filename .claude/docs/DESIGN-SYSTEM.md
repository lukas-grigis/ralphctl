# RalphCTL - TUI Design System

The single source of visual truth for the Ink TUI. Every view, prompt, and component follows the
tokens, patterns, and contracts in this document. Before adding a new component or one-off glyph,
read this first — most needs are already covered.

Companion docs:

- [REQUIREMENTS.md § UI Contract](./REQUIREMENTS.md#ui-contract) — the **testable** acceptance criteria for this design
  system.
- [ARCHITECTURE.md § Terminal UI Layer](./ARCHITECTURE.md#terminal-ui-layer-srcintegrationuitui) — file layout and
  runtime wiring.
- `src/integration/ui/theme/tokens.ts` — the tokens themselves, in code.

## 1. Design philosophy — "Technical Letterpress"

A developer tool should read like a well-set page, not a game HUD. That gives three rules:

1. **Typography carries hierarchy.** Bold + dim are the workhorse. Color is reserved for semantic state.
2. **Glyphs are a curated family.** One set, used consistently. A new glyph is a design decision, not a convenience.
3. **Personality is concentrated, not smeared.** Ralph lives in the Home banner and the occasional pull-quote — not on
   every screen.

If a change trades legibility for decoration, it fails the test. Restraint is the aesthetic.

## 2. Tokens

All tokens are exported from `src/integration/ui/theme/tokens.ts`. **Never inline a hex code, a
unicode glyph, or a magic spacing number in a view** — import the token.

### 2.1 Color — `inkColors`

Semantic only. Each color means the same thing in every surface.

| Token       | Hex       | Meaning                                     |
| ----------- | --------- | ------------------------------------------- |
| `success`   | `#7FB069` | completion, pass, done                      |
| `error`     | `#E76F51` | failure, blocked, fail                      |
| `warning`   | `#E8A13B` | in-progress, draft, paused, spinner default |
| `info`      | `#6CA6B0` | annotations, meta, help, info cards         |
| `muted`     | `#8B8680` | secondary text, inactive, disabled          |
| `highlight` | `#E8C547` | focus, selection, "next" marker             |
| `primary`   | `#E8C547` | brand accent — section stamps, active phase |
| `secondary` | `#D98880` | personality — quote rail, Ralph flavor bits |

Rules:

- Never `color="red"` / `"green"` / `"yellow"` — always `inkColors.error` / `inkColors.success` / `inkColors.warning`.
- **Focus pattern** is inline: `<Text color={inkColors.highlight} bold>…</Text>`. There is no separate `focus` token.
- Truecolor hex; terminals without truecolor fall back to ANSI-256 automatically.

### 2.2 Glyphs — `glyphs`

Canonical set. If a view needs a symbol not in this list, **add it to `glyphs` first** (and document it here).

| Group           | Tokens                                                                           |
| --------------- | -------------------------------------------------------------------------------- |
| Phase / status  | `phaseDone ■`, `phaseActive ◆`, `phasePending ◇`, `phaseDisabled ◌`              |
| Cursors         | `actionCursor ▸`, `selectMarker ›`                                               |
| Section markers | `badge ▣`, `sectionRule ━`                                                       |
| State           | `check ✓`, `cross ✗`, `warningGlyph ⚠`, `infoGlyph i`                            |
| Bullets         | `inlineDot ·`, `bulletListItem ·`, `emDash —`, `arrowRight →`, `activityArrow ↳` |
| Separators      | `separatorVertical │`                                                            |
| Motion          | `spinner` (braille frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`)                                          |
| Personality     | `quoteRail ┃`                                                                    |

Do not mix glyph families (no `✔` from one set and `✓` from another). No emoji in TUI surfaces — emoji is the plain-text
CLI's job (`emoji` from `theme.ts`).

### 2.3 Spacing — `spacing`

Vertical rhythm comes from a handful of constants. Every `marginTop` / `marginBottom` / `paddingX` value in a view
must reference one.

| Token         | Value | Use                                      |
| ------------- | ----- | ---------------------------------------- |
| `section`     | 1     | Blank line between top-level sections    |
| `actionBreak` | 2     | Breath before a final CTA / decision row |
| `indent`      | 2     | Left-indent for nested content / bullets |
| `gutter`      | 1     | Internal padding inside card-like boxes  |
| `cardPadX`    | 1     | Horizontal padding inside cards          |

`ViewShell` already handles header → body → hints spacing. Views only add spacing **inside** their body.

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

Field lists use `FIELD_LABEL_WIDTH = 12` from tokens. That fits the longest label in the app
(`Evaluation:`, `Repositories:`) with its colon. Override only when a specific view demands it.

## 3. Layout anatomy

Every non-Home view mounts through `<ViewShell>`:

```
┌─ ViewShell ─────────────────────────────────────┐
│  <SectionStamp title="VIEW TITLE" />            │ ← header (always)
│                                                 │
│  <body>  ← the view-specific content            │
│                                                 │
│  <PromptHost />  ← inline prompts (auto)        │
│                                                 │
│  <KeyboardHints />  ← view-local hints (auto)   │
└─────────────────────────────────────────────────┘
<StatusBar>  ← owned by the router (breadcrumb + global hotkeys)
```

**Views never render their own header, hint strip, or status bar.** `ViewShell` + router own all three.
Home is the single `bare` exception — it renders the Banner + pipeline map instead of a SectionStamp.

## 4. Component inventory

All components live in `src/integration/ui/tui/components/`. Use these. Don't write a sibling that does 90% of the same
job.

### 4.1 Shell + chrome

| Component       | Purpose                                                               |
| --------------- | --------------------------------------------------------------------- |
| `ViewShell`     | Frame for every view. Owns header + body + hints spacing.             |
| `SectionStamp`  | `▣ VIEW TITLE ━━━…` header. Brand-mustard accent.                     |
| `StatusBar`     | Breadcrumb + global hotkey hints. Owned by router. Never from a view. |
| `KeyboardHints` | View-local hotkey strip. Published via `useViewHints([…])`.           |
| `Banner`        | Home-only Ralph banner + pipeline map. Do not reuse elsewhere.        |

### 4.2 Content surfaces

| Component                             | Purpose                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ResultCard`                          | Terminal state surface: `success` / `error` / `warning` / `info`. Carries `title`, `fields`, `lines`, `nextSteps`. |
| `FieldList`                           | Aligned `[label, value]` rows. Used inside cards and detail views.                                                 |
| `StatusChip`                          | `[DRAFT]` / `[ACTIVE]` / `[CLOSED]` bracketed tag.                                                                 |
| `Spinner`                             | Braille-frame loading indicator with trailing label.                                                               |
| `ListView`                            | Paginated list with `↑/↓` + `Enter`. For browse screens.                                                           |
| `TaskGrid`                            | Execution dashboard grid (one row per task).                                                                       |
| `TaskRow`                             | Single row in the grid. Status glyph + name + project path.                                                        |
| `LogTail`                             | Rolling event tail (default 200). Subscribes to log event bus.                                                     |
| `RateLimitBanner`                     | Global pause banner on rate-limit coordinator pause.                                                               |
| `SprintSummaryLine` / `SprintSummary` | Home + dashboard summary surfaces.                                                                                 |
| `PipelineMap`                         | Home phase map (refine → plan → start → close).                                                                    |
| `ActionMenu`                          | Home action menu + submenus. Driven by `menu-builder.ts`.                                                          |
| `VersionHint`                         | Dim footer version tag.                                                                                            |

### 4.3 Prompt family (`src/integration/ui/prompts/`)

Never build a new prompt component. Always call `getPrompt()` and let `InkPromptAdapter` queue it.

| Prompt        | Returns          | Cancel behavior               |
| ------------- | ---------------- | ----------------------------- |
| `select`      | `T`              | throws `PromptCancelledError` |
| `confirm`     | `boolean`        | throws `PromptCancelledError` |
| `input`       | `string`         | throws `PromptCancelledError` |
| `checkbox`    | `T[]`            | throws `PromptCancelledError` |
| `editor`      | `string \| null` | returns `null` on cancel      |
| `fileBrowser` | `string \| null` | returns `null` on cancel      |

`editor` is the Claude-style multi-line inline editor (Ctrl+D submits, Esc cancels). No external editor spawn.

## 5. State surfaces — one visual per kind

Pick the right surface for the state. Don't mix raw `<Text color={inkColors.error}>…</Text>` with `ResultCard`.

| State                   | Surface                         | Notes                                                    |
| ----------------------- | ------------------------------- | -------------------------------------------------------- |
| Loading / running       | `<Spinner label="…" />`         | Warning color default. Never bare text.                  |
| Empty (no data)         | `<ResultCard kind="info" />`    | "No X yet" + `nextSteps` pointer.                        |
| Precondition failed     | `<ResultCard kind="warning" />` | "Needs Y first" + `nextSteps` pointer.                   |
| Error                   | `<ResultCard kind="error" />`   | `lines={[message]}`. No stack dumps in user-facing copy. |
| Success / terminal done | `<ResultCard kind="success" />` | `fields={…}` + `nextSteps={…}`.                          |
| Idle (waiting on input) | the prompt itself               | Don't render a spinner while a prompt is up.             |

## 6. Navigation contract

### 6.1 Global hotkeys — owned by the router

These work from **every** view. Don't override them.

| Key   | Action                        |
| ----- | ----------------------------- |
| `Esc` | Pop one frame (no-op at root) |
| `h`   | Home                          |
| `s`   | Settings overlay              |
| `d`   | Dashboard                     |
| `q`   | Quit (Home root only)         |

### 6.2 View-local keys — published via `useViewHints`

```tsx
useViewHints([
  { key: '↑/↓', action: 'move' },
  { key: 'Enter', action: 'open' },
  { key: 'b', action: 'browse' },
]);
```

Canonical vocabulary — reuse these spellings so users build one mental model:

| Key                                | Action                        |
| ---------------------------------- | ----------------------------- |
| `↑/↓`                              | move cursor                   |
| `←/→`                              | switch panes / prev/next page |
| `Enter`                            | confirm / open / run          |
| `Space`                            | toggle / multi-select         |
| `Tab` / `Shift+Tab`                | next / prev field             |
| `Ctrl+D`                           | submit multi-line editor      |
| a single letter (`b`, `r`, `n`, …) | the view's primary action     |

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
  {phase.kind === 'done' && <ResultCard kind="success" …/>}
  {phase.kind === 'error'   && <ResultCard kind="error" …/>}
    </ViewShell>
```

- Use `useWorkflow` for phase state.
- `phase.step` drives the spinner label — set it before each prompt.
- `Enter` on a terminal `ResultCard` pops the view.

### 7.2 List views (`browse/*-list-view.tsx`)

- `ListView` with `↑/↓ · Enter open · Esc back`.
- Empty state → `ResultCard kind="info"` with a `nextSteps` pointer.

### 7.3 Detail views (`browse/*-show-view.tsx`)

- `FieldList` for metadata.
- `StatusChip` for lifecycle state.
- No action verbs — detail views are read-only.

### 7.4 Phase views (refine / plan / close / execute)

- Behave like a workflow view: `SectionStamp`, phase state, `ResultCard` for outcome.
- No bespoke input handlers — everything goes through `getPrompt()`.

## 8. Copy & tone

### 8.1 Spinner labels

Imperative, present-continuous, one trailing ellipsis. Describe what **the harness** is doing, not what the user is
about to do.

| ✅                     | ❌                                             |
| ---------------------- | ---------------------------------------------- |
| `Loading sprints…`     | `Waiting for sprints…`                         |
| `Saving ticket…`       | `Ticket save in progress…`                     |
| `Fetching issue data…` | `Downloading issue data…`                      |
| `Generating tasks…`    | `AI is thinking…`                              |
|                        | `Type the sprint name…` (that's a prompt hint) |

### 8.2 Empty / error / next-step copy

- **Empty:** state the absence, then the next step. `No sprints yet.` + `Run 'sprint create'.`
- **Error:** state what failed, then what the user can do. Avoid stack traces in the card body.
- **Next step:** single-verb imperative. `Run sprint refine`. `Approve requirements`.

### 8.3 Status words

Use one spelling everywhere. `DRAFT`, `ACTIVE`, `CLOSED`, `DONE`, `IN PROGRESS`, `BLOCKED`, `FAILED`. No mixed case (
`In Progress`, `in progress`). No synonyms (`complete` vs `done`).

## 9. Anti-patterns (non-negotiables)

- ❌ Hardcoded hex — always `inkColors.*`.
- ❌ Inline unicode glyph — always `glyphs.*`.
- ❌ Magic spacing number — always `spacing.*`.
- ❌ Raw emoji inside an Ink view (emoji is the plain-text CLI's lane via `theme.ts → emoji`).
- ❌ View renders its own header / hint strip / status bar.
- ❌ View calls `console.log` / writes stdout directly — use the injected `LoggerPort`.
- ❌ View calls a use case directly — use pipeline factories (`createXxxPipeline`).
- ❌ View mounts a prompt outside `getPrompt()`.
- ❌ Mixing `<Text color={inkColors.error}>` with `ResultCard` in the same state.
- ❌ New prompt component — reuse `InkPromptAdapter`.
- ❌ Barrel `index.ts` files — every import points to its source module.

## 10. When to extend vs. reuse

Before adding anything new, work this ladder top-down:

1. **Does a token cover it?** Add color/glyph/spacing via `tokens.ts`, not ad-hoc.
2. **Does an existing component render it?** `ResultCard` + `FieldList` + `StatusChip` + `Spinner` handle ~80% of
   states.
3. **Is it a new state surface?** Add a `ResultCard` `kind`, don't build a parallel card.
4. **Is it a new view shape?** Describe it here first (add a § 7 subsection), then build it.
5. **Is it a new prompt kind?** Add a method to `PromptPort` + a prompt component under `src/integration/ui/prompts/`.

If you reach step 4 or 5, open a design note before the PR — this document should change with the code.

## 11. Checklist for new views

Run this before opening a PR on a new TUI surface:

- [ ] Wrapped in `<ViewShell>` (not bare, unless Home).
- [ ] Title is an ALL-CAPS `SectionStamp`.
- [ ] Every color / glyph / spacing value comes from `tokens.ts`.
- [ ] All interaction is a `getPrompt()` call.
- [ ] `useViewHints([…])` lists every key the view responds to.
- [ ] Loading state uses `<Spinner>`; terminal states use `<ResultCard>`.
- [ ] No use-case or adapter imported directly — pipeline factory or injected port only.
- [ ] A test asserts the happy path renders a `ResultCard kind="success"` (or equivalent terminal).
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all green.
