import { describe, expect, it } from 'vitest';
import {
  composeGeneratorHints,
  HINTS_MAX_ITEMS_PER_KIND,
  HINTS_MAX_LINES,
} from '@src/application/flows/implement/leaves/_shared/generator-hints.ts';
import type { LearningEntry } from '@src/domain/signal.ts';

/**
 * `composeGeneratorHints` builds the same-round generator observations the evaluator receives as
 * unverified environment context (T5). It is pure: prefers the most round-recent items, clamps
 * each line, and caps the section so a deep multi-round attempt can't balloon the prompt.
 */

describe('composeGeneratorHints', () => {
  it('returns empty string when all sources are empty / absent', () => {
    expect(composeGeneratorHints({})).toBe('');
    expect(composeGeneratorHints({ changes: [], learnings: [], notes: [] })).toBe('');
    expect(composeGeneratorHints({ commitSubject: '   ' })).toBe('');
  });

  it('renders the proposed commit subject on its own line', () => {
    const out = composeGeneratorHints({ commitSubject: 'feat: add dark mode' });
    expect(out).toBe('Proposed commit: feat: add dark mode');
  });

  it('renders changes as a bulleted subsection', () => {
    const out = composeGeneratorHints({ changes: ['added X', 'renamed Y to Z'] });
    expect(out).toContain('Changes the generator says it made:');
    expect(out).toContain('- added X');
    expect(out).toContain('- renamed Y to Z');
  });

  it('renders learnings with an inline applies-to suffix', () => {
    const learnings: readonly LearningEntry[] = [
      { text: 'dev server runs on port 4000', appliesTo: 'web-ui' },
      { text: 'use pnpm not npm' },
    ];
    const out = composeGeneratorHints({ learnings });
    expect(out).toContain('Environment notes / learnings:');
    expect(out).toContain('- dev server runs on port 4000 (applies to web-ui)');
    expect(out).toContain('- use pnpm not npm');
  });

  it('renders notes as a bulleted subsection', () => {
    const out = composeGeneratorHints({ notes: ['flaky test in suite A'] });
    expect(out).toContain('Notes:');
    expect(out).toContain('- flaky test in suite A');
  });

  it('composes all four sources in a stable order', () => {
    const out = composeGeneratorHints({
      commitSubject: 'fix: bug',
      changes: ['c1'],
      learnings: [{ text: 'l1' }],
      notes: ['n1'],
    });
    const commitIdx = out.indexOf('Proposed commit');
    const changesIdx = out.indexOf('Changes the generator');
    const learningsIdx = out.indexOf('Environment notes');
    const notesIdx = out.indexOf('Notes:');
    expect(commitIdx).toBeLessThan(changesIdx);
    expect(changesIdx).toBeLessThan(learningsIdx);
    expect(learningsIdx).toBeLessThan(notesIdx);
  });

  it('collapses internal whitespace and drops empty items', () => {
    const out = composeGeneratorHints({ changes: ['  added   the\nthing  ', '', '   '] });
    expect(out).toContain('- added the thing');
    // The two empty entries produce no bullet lines.
    expect(out.split('\n').filter((l) => l.startsWith('- ')).length).toBe(1);
  });

  it('keeps only the most-recent N items per kind', () => {
    const many = Array.from({ length: HINTS_MAX_ITEMS_PER_KIND + 5 }, (_v, i) => `change ${String(i)}`);
    const out = composeGeneratorHints({ changes: many });
    const bullets = out.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets.length).toBe(HINTS_MAX_ITEMS_PER_KIND);
    // The TAIL (most recent) is kept: the last change is present, the first is dropped.
    expect(out).toContain(`change ${String(HINTS_MAX_ITEMS_PER_KIND + 4)}`);
    expect(out).not.toContain('- change 0');
  });

  it('caps the total section to HINTS_MAX_LINES and marks the omission', () => {
    // Three kinds, each at the per-kind max, plus a commit subject — exceeds the line cap.
    const items = (prefix: string) =>
      Array.from({ length: HINTS_MAX_ITEMS_PER_KIND }, (_v, i) => `${prefix}${String(i)} ${'long '.repeat(3)}`);
    const out = composeGeneratorHints({
      commitSubject: 'subject',
      changes: items('c'),
      learnings: items('l').map((text) => ({ text })),
      notes: items('n'),
    });
    expect(out.split('\n').length).toBeLessThanOrEqual(HINTS_MAX_LINES + 1);
    expect(out).toContain('additional generator hints omitted');
  });
});
