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
 * Visible-row budget for windowed list prompts (multi-select today; single-select / pickers in
 * future). Keep all scrolling prompts to the same window height so the prompt frame stays a
 * predictable size across the TUI.
 */
export const PROMPT_VISIBLE_ROWS = 8;

/**
 * Layout widths for the Implement dashboard's rail / stream / context split. Fixed character
 * widths (no flex) so the stream column inherits all remaining space via `flexGrow={1}`.
 *
 *   - {@link RAIL_WIDTH} — left rail; carries the Flow Steps list.
 *   - {@link CONTEXT_WIDTH} — right context column; empty on day-one, populated later by
 *     baseline health (P1k), token meter (P2b), and ETA (P3a) cards.
 */
export const RAIL_WIDTH = 24;
export const CONTEXT_WIDTH = 28;
