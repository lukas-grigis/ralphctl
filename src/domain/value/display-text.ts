/**
 * Display sanitiser for prose the harness did NOT author — the model-written text that reaches an
 * operator's terminal: a `task-blocked` reason / question / `whatUnblocksMe`, a harness signal
 * body, a notification line. That text comes off a generator which has just read an
 * attacker-controllable repository, so it is data to be shown, never bytes the terminal may
 * interpret.
 *
 * Two jobs, both lossless for real prose:
 *
 *  - Strip every C0 (0x00–0x1F) and C1 (0x80–0x9F) control character, plus DEL (0x7F), keeping
 *    only TAB (0x09) and LINE FEED (0x0A). ESC (0x1B) goes with them, so no CSI / OSC sequence can
 *    survive to set the window title, clear the screen or drive an OSC 52 clipboard write; so does
 *    CR (0x0D), so a lone carriage return cannot overwrite a rendered line.
 *  - Clamp to a display budget (opt-in via `maxChars`) with a trailing ellipsis, so a multi-
 *    megabyte field cannot flood a one-line list row.
 *
 * Nothing else is touched: this NEUTERS, it does not reformat. Whitespace collapsing, first-line
 * slicing and width-based ellision stay the caller's business (`collapseWhitespace` in the Tasks
 * panel, `firstLine` in `settle-attempt.ts`, Ink's own `wrap="truncate-end"`).
 *
 * Sibling of `business/sprint/journal-sanitize.ts`, which guards the progress journal's MARKDOWN
 * structure against the same class of text; this one guards the TERMINAL. Pure — no I/O.
 *
 * @public
 */

/**
 * Per-field display budget for a CLI list row — generous for genuine prose (a blocked-task
 * question is a sentence or two), bounded for everything else. Deliberately not applied in the
 * TUI, where Ink ellides on the real terminal width instead.
 */
export const DISPLAY_TEXT_MAX_CHARS = 400;

const TAB = 0x09;
const LINE_FEED = 0x0a;
const C0_LAST = 0x1f;
const DEL = 0x7f;
const C1_LAST = 0x9f;

/**
 * Every control code point except the two that legitimately carry layout. Expressed as numeric
 * comparisons rather than literal characters so the source file itself stays free of the control
 * bytes it is here to remove.
 */
const isStrippedControl = (codePoint: number): boolean =>
  codePoint !== TAB && codePoint !== LINE_FEED && (codePoint <= C0_LAST || (codePoint >= DEL && codePoint <= C1_LAST));

/**
 * The same predicate as {@link isStrippedControl}, as a single regex scan — the detector for the
 * fast path below. Written with `\u` escapes so the source file still carries no literal control
 * byte; the ranges skip TAB (0x09) and LINE FEED (0x0A) exactly as the predicate does.
 */
// eslint-disable-next-line no-control-regex -- deliberate: this IS the control-character detector.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

/**
 * Strip control characters, then optionally clamp. Omit `maxChars` (or pass a non-positive one) to
 * keep the full length — the TUI wants that; the CLI passes {@link DISPLAY_TEXT_MAX_CHARS}. Both
 * the walk and the clamp work in CODE POINTS, so an astral character is never cut in half; the
 * ellipsis spends one of the budgeted points, so the result never exceeds `maxChars`.
 *
 * Clean text short-circuits on one regex scan rather than a per-code-point array build. That is
 * the overwhelmingly common case, and one caller makes it load-bearing: the TUI's tasks panel runs
 * this over every signal row on every render (~90 ms spinner cadence), including a `task-verified`
 * `output` whose only cap is the 4 MB whole-file limit — the walk costs ~4.5x the scan on a body
 * that size. `text.length` is UTF-16 units and the budget counts code points, so `length <=
 * maxChars` is a conservative "cannot need clamping" test; anything longer falls through to the
 * walk, which decides properly.
 */
export const sanitizeDisplayText = (text: string, maxChars?: number): string => {
  const mayNeedClamp = maxChars !== undefined && maxChars > 0 && text.length > maxChars;
  if (!mayNeedClamp && !CONTROL_RE.test(text)) return text;

  const kept: string[] = [];
  for (const character of text) {
    if (!isStrippedControl(character.codePointAt(0) ?? 0)) kept.push(character);
  }
  if (maxChars === undefined || maxChars <= 0 || kept.length <= maxChars) return kept.join('');
  return `${kept.slice(0, maxChars - 1).join('')}…`;
};
