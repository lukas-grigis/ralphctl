/**
 * Theme tokens for Ink components — the single source of visual truth for the TUI.
 *
 * Design direction: "Technical Letterpress". Color is used only for semantic
 * state (success/warning/error) and for focus. The workhorse is typography
 * (bold/dim) and spacing rhythm. Ralph personality lives in the banner and
 * the occasional pull-quote — not painted across every surface.
 */

export { colors, emoji, gradients, getRandomQuote, getStatusEmoji } from '@src/integration/ui/theme/theme.ts';

/**
 * Ink `color` prop values. Truecolor hex where ANSI-256 lookalikes would
 * look muddy; ANSI names where the palette is crisp enough. Terminals that
 * don't support truecolor fall back to the nearest ANSI-256 automatically.
 */
export const inkColors = {
  // Semantic state
  success: '#7FB069', // sage — not neon green, easier on the eyes
  error: '#E76F51', // warm coral — not a pure red klaxon
  warning: '#E8A13B', // amber
  info: '#6CA6B0', // dusty cyan
  // UI state
  muted: '#8B8680', // warm gray (hint of yellow, matches the mustard brand)
  highlight: '#E8C547', // brand mustard — focus / active
  // Brand
  primary: '#E8C547', // mustard — section stamps, accents
  secondary: '#D98880', // muted rose — Ralph personality pull-quotes
} as const;

export type InkColorName = (typeof inkColors)[keyof typeof inkColors];

/**
 * Curated glyph family — used consistently across views. Keep this set
 * small; adding a new glyph is a design decision, not a convenience.
 * See .claude/docs/UI-SPEC.md § Glyphs for when to use which.
 */
export const glyphs = {
  // Phase / status
  phaseDone: '■',
  phaseActive: '◆',
  phasePending: '◇',
  phaseDisabled: '◌',
  // Action cursors / bullets
  actionCursor: '▸',
  selectMarker: '›',
  bulletListItem: '·',
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
  separatorVertical: '│',
} as const;

/**
 * Spacing rhythm constants — use these everywhere instead of hardcoded magic
 * numbers so the whole TUI shares one vertical cadence. See UI-SPEC.md.
 */
export const spacing = {
  /** Between top-level sections (blank line). */
  section: 1,
  /** Before a final CTA row — a beat of breath before a decision. */
  actionBreak: 2,
  /** Card internal x-padding. */
  cardPadX: 1,
  /** Left-indent for nested content (steps, bullets, children). */
  indent: 2,
  /** Internal gutter inside card-like boxes. */
  gutter: 1,
} as const;

/**
 * Focus style — applied via `<Text color={focus.color} bold={focus.bold}>`
 * so selection/focus looks identical everywhere.
 */
export const focus = {
  color: inkColors.highlight,
  bold: true,
} as const;

/**
 * Standard label column width for field lists. 12 chars fits the longest
 * label in the app (`Evaluation:`, `Repositories:`) plus a trailing colon
 * without truncation.
 */
export const FIELD_LABEL_WIDTH = 12;
