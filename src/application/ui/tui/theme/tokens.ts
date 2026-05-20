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
 *   - {@link RAIL_WIDTH} — left rail; carries the Flow Steps list (labels visible).
 *   - {@link COMPACT_RAIL_WIDTH} — narrowed rail used at the intermediate 100–139 col
 *     breakpoint; the Flow Steps list collapses to status icons only, no labels.
 *   - {@link CONTEXT_WIDTH} — right context column; baseline health (P1k), token meter
 *     (P2b), and ETA (P3a) cards stack here at ≥180 cols.
 */
export const RAIL_WIDTH = 24;
export const COMPACT_RAIL_WIDTH = 6;
export const CONTEXT_WIDTH = 28;

/**
 * Signal-kind family used by the Tasks panel. Mirrors the keys of `SIGNAL_LABEL_COLOR` in
 * `tasks-panel.tsx`; declared here so {@link glyphFor} can name its discriminator without
 * pulling tasks-panel into tokens (sibling-isolation kept clean — tokens has no upward deps).
 *
 * @public
 */
export type SignalKind =
  | 'change'
  | 'learning'
  | 'decision'
  | 'commit'
  | 'note'
  | 'progress'
  | 'progress-entry'
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
 * (`progress` / `progress-entry` / `done` / `script` / `proposal` / `skills`) — adding a glyph
 * there would clutter the row without adding shape information.
 *
 * @public
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
