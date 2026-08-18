/**
 * The document overlays window by ROW COUNT, so their wrap helper owes one invariant above all
 * others: every row it returns fits the requested width. Everything else here (indent carrying,
 * long-word chopping, blank-row preservation) is about not making the artifact less readable
 * while enforcing that invariant.
 */

import { describe, expect, it } from 'vitest';
import {
  OVERLAY_CHROME_COLUMNS,
  overlayBodyColumns,
  wrapRow,
  wrapRows,
} from '@src/application/ui/tui/components/overlay-internals/wrap-document-rows.ts';

describe('wrapRow', () => {
  it('leaves a row that already fits untouched', () => {
    expect(wrapRow('short line', 40)).toEqual(['short line']);
  });

  it('preserves a blank row so the artifact keeps its rhythm', () => {
    expect(wrapRow('', 40)).toEqual(['']);
  });

  it('wraps a long paragraph so every row fits the width', () => {
    const paragraph = Array.from({ length: 60 }, (_, i) => `word${String(i).padStart(2, '0')}`).join(' ');
    const rows = wrapRow(paragraph, 30);

    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(30);
    // No prose is lost — the wrap is a reflow, not a truncation.
    expect(rows.join(' ').split(/\s+/).filter(Boolean)).toEqual(paragraph.split(' '));
  });

  it('carries the leading indent onto continuation rows', () => {
    const rows = wrapRow('    alpha beta gamma delta epsilon zeta eta theta', 20);

    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.startsWith('    ')).toBe(true);
  });

  it('chops a single word longer than the width instead of overflowing', () => {
    const rows = wrapRow(`prefix ${'x'.repeat(50)} suffix`, 20);

    for (const row of rows) expect(row.length).toBeLessThanOrEqual(20);
    expect(rows.join('')).toContain('x'.repeat(20));
    expect(rows.at(-1)).toContain('suffix');
  });

  it('preserves interior runs of spaces used for alignment', () => {
    const rows = wrapRow('    FAIL   tests/foo.test.ts', 40);

    expect(rows).toEqual(['    FAIL   tests/foo.test.ts']);
  });

  it('falls back to a hard split when the leading whitespace alone exceeds the width', () => {
    const rows = wrapRow(`${' '.repeat(12)}tail`, 10);

    for (const row of rows) expect(row.length).toBeLessThanOrEqual(10);
    expect(rows.join('')).toContain('tail');
  });
});

describe('wrapRows / overlayBodyColumns', () => {
  it('flattens a document so the row count matches what will be painted', () => {
    const doc = ['one', 'alpha beta gamma delta', ''];
    const rows = wrapRows(doc, 12);

    expect(rows).toEqual(['one', 'alpha beta', 'gamma delta', '']);
  });

  it('subtracts the overlay chrome from the terminal width', () => {
    expect(overlayBodyColumns(100)).toBe(100 - OVERLAY_CHROME_COLUMNS);
  });

  it('floors the width so a tiny terminal still wraps into something usable', () => {
    expect(overlayBodyColumns(4)).toBeGreaterThan(0);
  });
});
