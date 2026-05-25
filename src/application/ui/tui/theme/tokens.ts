/**
 * Theme tokens — single source of visual truth for the TUI.
 *
 * Direction: Technical Letterpress. Color encodes semantic state (success / warning / error /
 * info), nothing else. Typography (bold / dim) and spacing carry the structure. Personality
 * lives in the banner and Ralph quote — never painted across every surface.
 */

/** Truecolor hex values; terminals without truecolor fall back to the nearest ANSI-256. */
export const inkColors = {
  // Semantic state
  success: '#7FB069',
  error: '#E76F51',
  warning: '#E8A13B',
  info: '#6CA6B0',
  // UI state
  muted: '#8B8680',
  highlight: '#E8C547',
  // Brand
  primary: '#E8C547',
  secondary: '#D98880',
  // Subdued surface (keyline / divider tone)
  rule: '#5C5A56',
} as const;

/** Curated glyph family. Adding a glyph is a design decision, not a convenience. */
export const glyphs = {
  // Phase / status
  phaseDone: '■',
  phaseActive: '◆',
  phasePending: '◇',
  phaseDisabled: '◌',
  // Cursors / bullets
  actionCursor: '▸',
  selectMarker: '›',
  bullet: '·',
  arrowRight: '→',
  activityArrow: '↳',
  // Section markers
  badge: '▣',
  sectionRule: '━',
  // State confirmation
  check: '✓',
  cross: '✗',
  warningGlyph: '⚠',
  infoGlyph: 'i',
  // Loading (braille spinner frames)
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const,
  // Personality rail
  quoteRail: '┃',
  // Separators
  inlineDot: '·',
  emDash: '—',
  pipe: '│',
  // Display-clip markers (audit-[03]). `clipEllipsis` is the one-char trailing marker
  // appended after a width / char-count clip; `collapseExpand` is the multi-line affordance
  // suggesting that an expand hotkey reveals the hidden tail. Both are common-Unicode and
  // render on vt220-class emulators; ASCII fallback isn't wired because every emitter we
  // ship today (Ink's truncate-end via cli-truncate, our manual clips below) already uses
  // U+2026. If a downstream terminal ever shows the literal `…` as a `?`, this is the one
  // place to introduce a switch.
  clipEllipsis: '…',
  collapseExpand: '▼ more',
} as const;

/** Spacing rhythm. Use these everywhere in lieu of magic numbers. */
export const spacing = {
  /** Between top-level sections (one blank row). */
  section: 1,
  /** Before a final CTA row. */
  actionBreak: 2,
  /** Card internal x-padding. */
  cardPadX: 1,
  /** Indent for nested content. */
  indent: 2,
  /** Internal gutter inside card-like boxes. */
  gutter: 1,
} as const;

/** Standard label width for field lists (`Repositories:` is the longest label). */
export const FIELD_LABEL_WIDTH = 14;

/**
 * Responsive breakpoints (terminal columns). The numbers mirror the long-standing Execute-view
 * tiers (compact / medium / wide / ultra) and give every view a single vocabulary for layout
 * decisions — same idea as web `sm` / `md` / `lg` / `xl` / `2xl`, scaled to terminal widths.
 *
 * Convention: a view is "in" breakpoint X when `columns >= breakpoints[X]`. Choose the largest
 * breakpoint whose threshold is satisfied (use {@link breakpointFor}).
 *
 *   sm   ≥ 80   — single-column stack; minimum supported width.
 *   md   ≥ 100  — narrow-but-multi-column space (Execute compact rail).
 *   lg   ≥ 140  — two-column layouts viable (rail + main).
 *   xl   ≥ 180  — three-column layouts viable (rail + main + context).
 *   xxl  ≥ 220  — extra horizontal room; rails and context can grow.
 */
export const breakpoints = {
  sm: 80,
  md: 100,
  lg: 140,
  xl: 180,
  xxl: 220,
} as const;

export type Breakpoint = keyof typeof breakpoints;

/**
 * Resolve the active breakpoint for a given terminal width. Returns the largest breakpoint key
 * whose threshold is satisfied — `sm` is the floor, so any width ≥ 0 maps to at least `sm`.
 */
export const breakpointFor = (columns: number): Breakpoint => {
  if (columns >= breakpoints.xxl) return 'xxl';
  if (columns >= breakpoints.xl) return 'xl';
  if (columns >= breakpoints.lg) return 'lg';
  if (columns >= breakpoints.md) return 'md';
  return 'sm';
};

/**
 * Fluid sizing helper — clamps `floor(columns * ratio)` to `[min, max]`. Use for widths that
 * should grow with the terminal but never overwhelm or vanish (e.g. a sidebar that wants ~18%
 * of the screen but at least 28 cols and at most 40).
 */
export const fluid = (
  columns: number,
  opts: { readonly min: number; readonly max: number; readonly ratio: number }
): number => Math.min(opts.max, Math.max(opts.min, Math.floor(columns * opts.ratio)));

/**
 * Pick a value per breakpoint. Falls through to smaller breakpoints when the active one isn't
 * specified — `sm` is required as the floor. Use for non-numeric responsive choices (e.g.
 * "show full label vs. abbreviation").
 *
 * @public — canonical breakpoint helper (see CLAUDE.md § TUI), retained for downstream consumers
 *   even when no current call-site exists.
 */
export const responsive = <T>(
  columns: number,
  values: { readonly sm: T; readonly md?: T; readonly lg?: T; readonly xl?: T; readonly xxl?: T }
): T => {
  const bp = breakpointFor(columns);
  if (bp === 'xxl' && values.xxl !== undefined) return values.xxl;
  if ((bp === 'xxl' || bp === 'xl') && values.xl !== undefined) return values.xl;
  if ((bp === 'xxl' || bp === 'xl' || bp === 'lg') && values.lg !== undefined) return values.lg;
  if (bp !== 'sm' && values.md !== undefined) return values.md;
  return values.sm;
};

/**
 * Visible-row budget for windowed list prompts (multi-select today; single-select / pickers in
 * future). Keep all scrolling prompts to the same window height so the prompt frame stays a
 * predictable size across the TUI.
 */
export const PROMPT_VISIBLE_ROWS = 8;

/**
 * Layout widths for the Implement dashboard's rail / stream / context split. Fixed character
 * widths (no flex) so the stream column inherits all remaining space via `flexGrow={1}`.
 *
 *   - {@link RAIL_WIDTH} — left rail; carries the Flow Steps list (labels visible).
 *   - {@link COMPACT_RAIL_WIDTH} — narrowed rail used at the intermediate 100–139 col
 *     breakpoint; the Flow Steps list collapses to status icons only, no labels.
 *   - {@link CONTEXT_WIDTH} — right context column; baseline health (P1k), token meter
 *     (P2b), and ETA (P3a) cards stack here at ≥180 cols.
 */
export const RAIL_WIDTH = 28;
export const COMPACT_RAIL_WIDTH = 6;
export const CONTEXT_WIDTH = 28;

/**
 * Fluid Execute-view rail width — grows with terminal width at the `xl` breakpoint and above
 * so step labels don't wrap mid-word on wide terminals. Below `xl` the fixed {@link RAIL_WIDTH}
 * applies (`lg`) or the compact rail kicks in (`md`).
 *
 *   < lg (≥ 140)  →  RAIL_WIDTH      (28)
 *   ≥ lg, < xl    →  RAIL_WIDTH      (28)   — two-column layout, no context column to compete
 *   ≥ xl  (≥ 180) →  fluid(36..56, 0.22) — three-column layout; rail grows up to 56 cols
 *
 * The xl ratio / cap were bumped (0.18→0.22, 40→56) so long element labels — e.g.
 * `setup-script-runner — setup-script for <abs-path> exited 1` — keep their error tail on a
 * single row on wide terminals (≥200 cols). The Tasks column still has flex-grow so any
 * extra width the rail doesn't claim flows there.
 */
export const resolveRailWidth = (columns: number): number => {
  if (columns < breakpoints.xl) return RAIL_WIDTH;
  return fluid(columns, { min: 36, max: 56, ratio: 0.22 });
};

/**
 * Signal-kind family used by the Tasks panel. Mirrors the keys of `SIGNAL_LABEL_COLOR` in
 * `tasks-panel.tsx`; declared here so {@link glyphFor} can name its discriminator without
 * pulling tasks-panel into tokens (sibling-isolation kept clean — tokens has no upward deps).
 */
export type SignalKind =
  | 'change'
  | 'learning'
  | 'decision'
  | 'commit'
  | 'note'
  | 'done'
  | 'verified'
  | 'blocked'
  | 'script'
  | 'proposal'
  | 'skills';

/**
 * Shape-only fallback marker per signal kind — printed BEFORE the kind label when colour
 * encoding isn't available (NO_COLOR=1, non-truecolor terminal, accessibility setting). Pairs
 * with the colour map in `tasks-panel.tsx` so the two encodings stay redundant rather than
 * fighting each other.
 *
 * Glyphs are deliberately ASCII / common-Unicode (no Powerline / Nerd-Font glyphs) so they
 * render uniformly across vt220-class emulators where colour is most likely to be disabled.
 *
 * Returns the empty string for kinds that already read distinctly from their label text
 * (`done` / `script` / `proposal` / `skills`) — adding a glyph there would clutter the row
 * without adding shape information.
 */
export const glyphFor = (kind: SignalKind): string => {
  switch (kind) {
    case 'change':
      return '+';
    case 'learning':
      return '~';
    case 'decision':
      return '◇';
    case 'verified':
      return '★';
    case 'blocked':
      return '△';
    case 'commit':
      return '■';
    case 'note':
      return '•';
    default:
      return '';
  }
};
