/**
 * `collapseWhitespace` — the Tasks panel's one choke point for model-authored prose.
 *
 * It does two jobs that are easy to confuse for one: it flattens real whitespace so a multi-line
 * signal body renders as a single row, AND it strips the control characters JS `\s` does not
 * match (ESC, BEL, the rest of C0). The rendered-frame tests cover the first job from the
 * outside; these pin the second directly, because a regression there is invisible in a frame
 * assertion — `lastFrame()` happily reports a string with an intact CSI sequence in it.
 *
 * Control bytes are built with `String.fromCharCode` on purpose: a literal ESC in this file would
 * be invisible in a diff and would itself be a payload in the repository.
 */

import { describe, expect, it } from 'vitest';
import { collapseWhitespace } from '@src/application/ui/tui/components/tasks-panel-internals/format.ts';

const chr = (code: number): string => String.fromCharCode(code);
const ESC = chr(0x1b);
const BEL = chr(0x07);

describe('collapseWhitespace', () => {
  it('collapses every run of ordinary whitespace to one space', () => {
    expect(collapseWhitespace('verified\n\n  three   criteria\tgreen')).toBe('verified three criteria green');
  });

  it('strips ESC and BEL, so an OSC title/clipboard payload can never reach Ink', () => {
    const sanitized = collapseWhitespace(`${ESC}]0;pwned${BEL} blocked on a decision`);
    expect(sanitized).not.toContain(ESC);
    expect(sanitized).not.toContain(BEL);
    expect(sanitized).toBe(']0;pwned blocked on a decision');
  });

  it('does both at once — the strip runs first, so a stripped byte cannot fuse two words', () => {
    // `ESC` sits between two spaces: stripping it leaves two spaces, which the collapse then
    // folds into one. Collapsing first would have left `reason  glyph` with a double space.
    expect(collapseWhitespace(`reason ${ESC} glyph`)).toBe('reason glyph');
  });

  it('keeps ordinary prose (including punctuation) untouched', () => {
    const text = 'blocked upstream — prerequisite not done: Foundation (blocked)';
    expect(collapseWhitespace(text)).toBe(text);
  });
});
