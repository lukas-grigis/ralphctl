# ralphctl UI Spec

The contract every TUI view follows. Goal: the app feels written from one hand — same
layout, same keys, same language on every screen.

Changes to TUI primitives MUST update this doc.

---

## Design intent — "Technical Letterpress"

Typography is the workhorse: bold + dim carry hierarchy, color carries semantic state.
Ralph personality is concentrated in the banner + quote, not smeared across every view.
Glyphs are a curated, consistent family — ■ ◆ ◇ ▸ ▣ ━ │ ↳ ◌ and the braille spinner.

## Anatomy of a view

Every view mounts through `<ViewShell>`:

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

Views never render their own header box, spacing boxes between sections, or hint footer.
`ViewShell` owns all three.

## Keyboard contract

**Global hotkeys** — owned by the router, work from EVERY view:

- `Esc` — pop one frame (no-op at root)
- `h` — home
- `s` — settings
- `d` — dashboard
- `q` — quit (home root only)

**View-local keys** — declared via `useViewHints()`. Common vocabulary:

- `↑/↓` — move cursor
- `←/→` — switch panes / previous/next page
- `Enter` — confirm / open / run
- `Space` — toggle / multi-select
- `Tab` / `Shift+Tab` — next / prev field
- `Ctrl+D` — submit multi-line editor
- A single letter (`b`, `r`, `n`, …) — primary view action, always shown in hints

**Rules:**

- Any undocumented key is a bug. If a view responds to it, hint for it.
- `Enter` on a terminal/result state pops the view.
- `Esc` in a submode returns to the parent mode before being claimed by the router.

## Navigation

- **Workflow views** (add / edit / remove / configure): use `useWorkflow` hook.
  Phase discriminator drives spinner + result card. Enter on terminal → pop.
- **List views** (`browse/*-list-view.tsx`): `ListView` with `↑/↓ · Enter open · Esc back`.
- **Detail views** (`browse/*-show-view.tsx`): `FieldList` + `StatusChip` for metadata.
- **Phase views** (refine / plan / close / execute): behave like a workflow view —
  `<SectionStamp>`, `useWorkflow` (or `useWorkflow`-compatible state machine),
  `<ResultCard>` for the outcome. **No bespoke input handlers.**

## Prompts

- Always go through `getPrompt()` — no direct Ink input components in a view.
- `<PromptHost>` renders inside `<ViewShell>` between body and hints — not after the
  status bar, not before the header. (`ViewShell` owns placement.)
- Multi-step forms: set `phase.step` before each prompt so the spinner reflects what
  the user is answering.

## Spinner labels

Imperative, ends with a single ellipsis. Reserve the verb for the _action the harness
is performing_, not what the user is about to do.

- ✅ `Loading sprints…` / `Saving ticket…` / `Fetching issue data…` / `Generating tasks…`
- ❌ `Type the title…` (that's a prompt hint, not a spinner state)
- ❌ `Waiting for sprint name…` (passive; rewrite as "Enter sprint name…" hint, not spinner)

When the view is idle waiting on a prompt, **don't show a spinner**. Show the prompt.

## States — one surface per kind

| State                   | Surface                         | Notes                                      |
| ----------------------- | ------------------------------- | ------------------------------------------ |
| Loading / running       | `<Spinner label="…" />`         | Warning color default; never bare text     |
| Empty (no data to show) | `<ResultCard kind="info" />`    | "No X yet" with a `nextSteps` pointer      |
| Precondition failed     | `<ResultCard kind="warning" />` | "Needs Y first" with a `nextSteps` pointer |
| Error                   | `<ResultCard kind="error" />`   | Carry `lines={[message]}`                  |
| Success                 | `<ResultCard kind="success" />` | `fields={…}` + `nextSteps={…}`             |

Never mix raw `<Text color="red">` with `ResultCard`. Pick a surface.

## Layout tokens

Every `marginTop` / `marginBottom` / `padding*` value must come from `tokens.spacing`:

- `spacing.section` — vertical gap between sections (= 1)
- `spacing.indent` — left-indent for nested content (= 2)
- `spacing.gutter` — padding inside card-like boxes (= 1)

No hardcoded numbers. ViewShell already spaces header → body → hints correctly;
views only add spacing inside their body.

## Glyphs

All symbols come from `tokens.glyphs`. Never inline a unicode character.

Canonical set:

- `phaseDone` (■), `phaseActive` (◆), `phasePending` (◇), `phaseDisabled` (◌)
- `actionCursor` (▸), `selectMarker` (›)
- `badge` (▣), `sectionRule` (━)
- `check` (✓), `cross` (✗)
- `warningGlyph` (⚠), `infoGlyph` (i)
- `inlineDot` (·), `emDash` (—), `arrowRight` (→), `activityArrow` (↳)
- `separatorVertical` (│)
- `spinner` (braille frames), `quoteRail` (┃)

## Colors

Semantic only. Never `color="red"` — always `inkColors.error`.

- `success` (sage) — completion, pass, done
- `error` (coral) — failure, blocked, fail
- `warning` (amber) — in-progress, draft, paused
- `info` (dusty cyan) — annotations, meta, help
- `muted` (warm gray) — secondary, inactive, disabled
- `highlight` (mustard) — focus, selection, "next" marker
- `primary` (mustard) — brand accent (section stamps)
- `secondary` (rose) — personality (quote rail)

**Focus pattern:** `{ color: inkColors.highlight, bold: true }` — codified as
`focus` object in tokens.

## View-hints contract (`useViewHints`)

Each view declares its keys once:

```tsx
useViewHints([
  { key: '↑/↓', action: 'move' },
  { key: 'Enter', action: 'open' },
  { key: 'b', action: 'browse' },
]);
```

Hints render in `<KeyboardHints />` at the bottom of `<ViewShell>`. The StatusBar
only ever shows _global_ hotkeys — no more duplication.

Order: view-local hints first, global hotkeys second (owned by StatusBar below).

## Home

Home is the only screen that renders the Banner + PullQuote + pipeline map + sprint
summary. Every OTHER screen is a plain `<ViewShell>` — no banner, no quote, no
hero. Keeps navigation cheap.

## Dashboard

Read-only status destination. Shows task grid, blockers, sprint summary hero.
`d` from anywhere. Escape pops back.

## Execute

Live dashboard during sprint execution. Subscribes to `SignalBusPort` + log event bus.
`s` still pushes settings on top (live-config edit lands on next task — REQ-12).

## Settings

`SettingsPanel` rows are generated from `getAllSchemaEntries()`. Editing a field
saves immediately. Esc closes. View-local hints: `↑/↓ navigate · Enter edit`.

## Non-negotiables

- No view writes to `console.log` / stdout directly. Use the injected `LoggerPort`.
- No view calls a use case directly. Use pipeline factories.
- No view mounts a prompt outside `getPrompt()`.
- No view renders its own hint footer. Use `useViewHints()`.
- `pnpm typecheck && pnpm lint && pnpm test` must pass at every commit.
