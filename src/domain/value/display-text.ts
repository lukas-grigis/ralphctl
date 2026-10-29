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
 */

/**
 * Per-field display budget for a CLI list row — generous for genuine prose (a blocked-task
 * question is a sentence or two), bounded for everything else. Deliberately not applied in the
 * TUI, where Ink ellides on the real terminal width instead.
 */
export const DISPLAY_TEXT_MAX_CHARS = 400;

/**
 * Every C0 / C1 control and DEL except TAB and LINE FEED. `\u` escapes keep the source file free of
 * the control bytes it removes.
 */
// eslint-disable-next-line no-control-regex -- deliberate: this IS the control-character detector.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/**
 * Strip control characters, then optionally clamp to `maxChars` CODE POINTS (so an astral character
 * is never halved; the ellipsis counts against the budget). Omit `maxChars` to keep the full length —
 * the TUI does; the CLI passes {@link DISPLAY_TEXT_MAX_CHARS}. Hot path: the TUI runs this over
 * multi-megabyte signal bodies on every render, so the clean, short case costs one scan.
 */
export const sanitizeDisplayText = (text: string, maxChars?: number): string => {
  const clean = text.replace(CONTROL_RE, '');
  // `.length` counts UTF-16 units, an upper bound on code points — so this only skips safe cases.
  if (maxChars === undefined || maxChars <= 0 || clean.length <= maxChars) return clean;
  const codePoints = [...clean];
  return codePoints.length <= maxChars ? clean : `${codePoints.slice(0, maxChars - 1).join('')}…`;
};
