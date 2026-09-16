/**
 * `sanitizeDisplayText` is the single choke point between model-authored prose and the operator's
 * terminal. The `task-blocked` triage fields (`reason` / `question` / `whatUnblocksMe`) are written
 * by a generator that has just read an attacker-controllable repository, so a prompt-injected
 * answer can carry ANSI/OSC bytes that the terminal executes on `ralphctl task list` — or a
 * multi-megabyte body that floods one list row. Both are neutered here.
 *
 * Control characters are built with `String.fromCharCode` on purpose: a literal ESC in this file
 * would be invisible in a diff and would itself be a payload in the repository.
 */

import { describe, expect, it } from 'vitest';
import { DISPLAY_TEXT_MAX_CHARS, sanitizeDisplayText } from '@src/domain/value/display-text.ts';

const chr = (code: number): string => String.fromCharCode(code);
const ESC = chr(0x1b);

describe('sanitizeDisplayText', () => {
  it('leaves ordinary prose untouched', () => {
    const text = 'Which database should this task connect to? (staging or prod — it matters)';
    expect(sanitizeDisplayText(text)).toBe(text);
  });

  it('strips ESC so a CSI colour sequence can never form', () => {
    expect(sanitizeDisplayText(`${ESC}[31mred${ESC}[0m`)).toBe('[31mred[0m');
  });

  it('strips the OSC window-title / clipboard payload down to inert text', () => {
    // `ESC ] 0 ; pwned BEL` — the title-set sequence; `ESC ] 52` is the clipboard-write one.
    const osc = `${ESC}]0;pwned${chr(0x07)}`;
    const sanitized = sanitizeDisplayText(osc);
    expect(sanitized).toBe(']0;pwned');
    expect(sanitized).not.toContain(ESC);
    expect(sanitized).not.toContain(chr(0x07));
  });

  it('strips CR so a lone carriage return cannot overwrite the rendered line', () => {
    expect(sanitizeDisplayText(`blocked${chr(0x0d)}all good`)).toBe('blockedall good');
  });

  it('keeps tab and newline — the two controls that legitimately carry layout', () => {
    expect(sanitizeDisplayText('line one\nline\ttwo')).toBe('line one\nline\ttwo');
  });

  it('strips DEL and the C1 block', () => {
    expect(sanitizeDisplayText(`a${chr(0x7f)}b${chr(0x9b)}c${chr(0x80)}d`)).toBe('abcd');
  });

  it('does not clamp when no budget is given — the TUI ellides on real terminal width instead', () => {
    const long = 'x'.repeat(DISPLAY_TEXT_MAX_CHARS * 3);
    expect(sanitizeDisplayText(long)).toHaveLength(DISPLAY_TEXT_MAX_CHARS * 3);
  });

  it('clamps to the budget with an ellipsis, never exceeding it', () => {
    const clamped = sanitizeDisplayText('y'.repeat(50), 10);
    expect(clamped).toBe(`${'y'.repeat(9)}…`);
    expect([...clamped]).toHaveLength(10);
  });

  it('leaves a text already inside the budget unclamped (no stray ellipsis)', () => {
    expect(sanitizeDisplayText('short', DISPLAY_TEXT_MAX_CHARS)).toBe('short');
  });

  it('clamps AFTER stripping, so control bytes never consume the budget', () => {
    const payload = `${ESC.repeat(20)}${'z'.repeat(5)}`;
    expect(sanitizeDisplayText(payload, 10)).toBe('zzzzz');
  });

  it('counts code points, so an astral character is never cut in half', () => {
    // Four astral code points (8 UTF-16 units) clamped to 3 → two kept plus the ellipsis.
    const clamped = sanitizeDisplayText('🧱🧱🧱🧱', 3);
    expect(clamped).toBe('🧱🧱…');
    expect([...clamped]).toHaveLength(3);
  });

  it('collapses a multi-megabyte field to the budget instead of flooding a list row', () => {
    const flood = 'a'.repeat(2_000_000);
    expect([...sanitizeDisplayText(flood, DISPLAY_TEXT_MAX_CHARS)]).toHaveLength(DISPLAY_TEXT_MAX_CHARS);
  });

  // Clean text short-circuits before the per-code-point walk (the TUI runs this over an unbounded
  // `task-verified` output on every render). The short-circuit tests `text.length`, which counts
  // UTF-16 units, while the budget counts CODE POINTS — so an astral string can be "too long" for
  // the fast path and still be inside the budget. It must fall through to the walk and come back
  // unclamped, not gain a stray ellipsis.
  it('does not clamp an astral string whose UTF-16 length exceeds a budget its code points do not', () => {
    expect(sanitizeDisplayText('🧱🧱', 3)).toBe('🧱🧱');
    expect(sanitizeDisplayText('🧱🧱', 2)).toBe('🧱🧱');
  });

  it('returns clean text unchanged whether or not a budget is given', () => {
    const clean = 'plain prose\nwith a tab\there';
    expect(sanitizeDisplayText(clean)).toBe(clean);
    expect(sanitizeDisplayText(clean, DISPLAY_TEXT_MAX_CHARS)).toBe(clean);
  });
});
