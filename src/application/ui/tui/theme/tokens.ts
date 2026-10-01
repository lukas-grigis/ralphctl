/** Theme tokens — single source of visual truth for the TUI. Direction: Technical Letterpress. */

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
  // Left focus rail printed beside the focused picker row (sprint picker today). A partial block
  // (U+258D) reads as a solid gutter mark without filling the whole cell like `▉` would.
  focusBar: '▍',
  // Disclosure carets for collapsible rows (Tasks-panel commit-message rows today).
  disclosureCollapsed: '▸',
  disclosureExpanded: '▾',
  // Filled circle for the gen-eval busy indicator — the small `bullet` reads as a separator, so the busy role needs a
  // heavier dot to register as an activity affordance.
  busyDot: '●',
  arrowRight: '→',
  // Update-available marker in the tab bar (`↑ v0.26.0`). Shape-only, survives NO_COLOR.
  arrowUp: '↑',
  activityArrow: '↳',
  // Section markers
  badge: '▣',
  sectionRule: '━',
  // State confirmation
  check: '✓',
  cross: '✗',
  warningGlyph: '⚠',
  infoGlyph: 'i',
  // Verdict / state the parser could not determine. Deliberately shape-only (never tinted) so it
  // reads apart from `check` / `cross` / `bullet` even under NO_COLOR.
  unknownGlyph: '?',
  // Skill-catalog "locally edited" marker — distinct shape from `warningGlyph` (an upstream
  // update is available) and `cross` (removed/broken) so the three states read apart even
  // without colour (NO_COLOR / accessibility).
  modified: '✎',
  // Health marker — footer doctor indicator. Monochrome medical cross, tinted by probe status;
  // renders without color so it survives NO_COLOR (no emoji).
  stethoscope: '✚',
  // Progress bar — filled / remaining cells of a fixed-width meter (TokenBudgetCard context bar).
  // Full block vs. light shade so the ratio reads by density alone, without colour.
  barFilled: '█',
  barEmpty: '░',
  // Text-input cursor (text / text-area prompts). Same character as `barFilled` but a separate
  // token on purpose — a caret and a meter cell are different roles, and either may diverge.
  caretBlock: '█',
  // Loading (braille spinner frames)
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const,
  // Personality rail
  quoteRail: '┃',
  // Separators
  inlineDot: '·',
  emDash: '—',
  pipe: '│',
  // Reloading affordance (used by FeedbackLine 'info' tone for reload messages).
  refresh: '↻',
  // Display-clip markers (audit-[03]).
  clipEllipsis: '…',
  collapseExpand: '▼ more',
  // Windowed-list overflow cues (Tasks column / any anchored window).
  moreAbove: '▴',
  moreBelow: '▾',
} as const;

/** Semantic tones — one colour + one shape per meaning, so outcome survives NO_COLOR. */
export type Tone = 'success' | 'warning' | 'error' | 'info' | 'muted';

export const tones: Readonly<Record<Tone, { readonly color: string; readonly glyph: string }>> = {
  success: { color: inkColors.success, glyph: glyphs.check },
  warning: { color: inkColors.warning, glyph: glyphs.warningGlyph },
  error: { color: inkColors.error, glyph: glyphs.cross },
  info: { color: inkColors.info, glyph: glyphs.infoGlyph },
  muted: { color: inkColors.muted, glyph: glyphs.phasePending },
};

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

/** Responsive breakpoints (terminal columns). */
export const breakpoints = {
  sm: 80,
  md: 100,
  lg: 140,
  xl: 180,
  xxl: 220,
} as const;

export type Breakpoint = keyof typeof breakpoints;

/** Resolve the active breakpoint for a given terminal width. */
export const breakpointFor = (columns: number): Breakpoint => {
  if (columns >= breakpoints.xxl) return 'xxl';
  if (columns >= breakpoints.xl) return 'xl';
  if (columns >= breakpoints.lg) return 'lg';
  if (columns >= breakpoints.md) return 'md';
  return 'sm';
};

/** Fluid sizing helper — clamps `floor(columns * ratio)` to `[min, max]`. */
export const fluid = (
  columns: number,
  opts: { readonly min: number; readonly max: number; readonly ratio: number }
): number => Math.min(opts.max, Math.max(opts.min, Math.floor(columns * opts.ratio)));

/**
 * Default vertical chrome a windowed-list view reserves outside the list itself: the five chrome rows (tab bar,
 * location line, rule, footer rule, hint row) plus the two overflow-cue rows.
 */
export const LIST_CHROME_ROWS = 7;

/** Visible-row (or visible-card) budget for a windowed list, derived from the terminal height. */
export const listCapacity = (
  rows: number,
  opts: {
    readonly rowHeight?: number;
    readonly chromeRows?: number;
    readonly min: number;
    readonly max?: number;
  }
): number => {
  const rowHeight = opts.rowHeight ?? 1;
  const chromeRows = opts.chromeRows ?? LIST_CHROME_ROWS;
  const available = Math.floor(Math.max(0, rows - chromeRows) / rowHeight);
  const floored = Math.max(opts.min, available);
  return opts.max !== undefined ? Math.min(opts.max, floored) : floored;
};

/**
 * Pick a value per breakpoint. Falls through to smaller breakpoints when the active one isn't specified — `sm` is
 * required as the floor.
 * @public — canonical breakpoint helper (see CLAUDE.md § TUI), retained for downstream consumers
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
 * Visible-row budget for windowed list prompts (multi-select today; single-select / pickers in future).
 */
export const PROMPT_VISIBLE_ROWS = 8;

/** Layout widths for the Implement dashboard's rail / stream / context split. */
export const RAIL_WIDTH = 28;
export const COMPACT_RAIL_WIDTH = 6;
export const CONTEXT_WIDTH = 28;

/**
 * Fluid Execute-view rail width — grows with terminal width at the `xl` breakpoint and above so step labels don't
 * wrap mid-word on wide terminals.
 */
export const resolveRailWidth = (columns: number): number => {
  if (columns < breakpoints.xl) return RAIL_WIDTH;
  return fluid(columns, { min: 36, max: 56, ratio: 0.22 });
};

/** Signal-kind family used by the Tasks panel. */
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
  | 'skills'
  | 'reproduce'
  | 'judge';

/**
 * Shape-only fallback marker per signal kind — printed BEFORE the kind label when colour encoding isn't available
 * (NO_COLOR=1, non-truecolor terminal, accessibility setting).
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
