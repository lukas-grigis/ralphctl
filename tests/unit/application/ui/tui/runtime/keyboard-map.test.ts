/**
 * Pure-data tests for the centralised keyboard map — the footer's global hints (derived from where
 * the operator is, not a static list) and the nav chords.
 *
 * Invariants the footer relies on:
 *  - the hidden accelerators (`h n x s ! S P`) are never advertised;
 *  - `esc <parent>` appears only when `esc` does something (deeper stack, or a non-Work section root);
 *  - `q quit` appears only on the Work root;
 *  - `1–5 sections` appears only at `lg` and wider.
 */

import { describe, expect, it } from 'vitest';
import {
  buildFooterGlobalHints,
  globalKeys,
  keySections,
  listKeys,
  type FooterGlobalsInput,
} from '@src/application/ui/tui/runtime/keyboard-map.ts';

const hintsFor = (over: Partial<FooterGlobalsInput>): string[] =>
  buildFooterGlobalHints({
    stackDepth: 1,
    parentLabel: undefined,
    onWorkRoot: false,
    atOtherSectionRoot: false,
    wide: false,
    ...over,
  }).map((h) => `${h.keys} ${h.label}`);

describe('buildFooterGlobalHints', () => {
  it('on the Work root: help and quit only', () => {
    expect(hintsFor({ onWorkRoot: true })).toEqual(['? help', 'q/ctrl+c quit']);
  });

  it('at another section root: esc goes to work, and there is no quit', () => {
    expect(hintsFor({ atOtherSectionRoot: true })).toEqual(['esc work', '? help']);
  });

  it('deeper in a stack: esc names the parent', () => {
    expect(hintsFor({ stackDepth: 2, parentLabel: 'Sprints' })).toEqual(['esc Sprints', '? help']);
  });

  it('adds `1–5 sections` only from lg, before help', () => {
    expect(hintsFor({ onWorkRoot: true, wide: true })).toEqual(['1–5 sections', '? help', 'q/ctrl+c quit']);
    expect(hintsFor({ onWorkRoot: true, wide: false })).not.toContain('1–5 sections');
  });

  it('never advertises the hidden accelerators', () => {
    const all = hintsFor({ onWorkRoot: true, wide: true }).join(' | ');
    for (const stale of ['h home', 'n new flow', 'x sessions', 's settings', 'P pick project', 'S pick sprint']) {
      expect(all).not.toContain(stale);
    }
  });
});

describe('listKeys contract', () => {
  it('top/bottom use Home/End (not g/G) after the progress-overlay key-conflict resolution', () => {
    expect(listKeys.top.keys).toEqual(['Home']);
    expect(listKeys.bottom.keys).toEqual(['End']);
  });
});

describe('g/G key-conflict guard (Finding 2)', () => {
  /**
   * `g` is bound globally to "open progress overlay".
   * It must NOT appear in listKeys (which could be active simultaneously on any list view).
   * This test locks in the resolution so a future re-introduction of vim aliases fails early.
   */
  it('g is not a listKeys binding (reserved for globalKeys.progressOverlay)', () => {
    const listKeyValues = new Set<string>(Object.values(listKeys).flatMap((b) => b.keys));
    expect(listKeyValues.has('g'), 'g must not be in listKeys — it is reserved for globalKeys.progressOverlay').toBe(
      false
    );
    expect(
      listKeyValues.has('G'),
      'G must not be in listKeys — it is reserved for globalKeys.progressOverlay (shift-g)'
    ).toBe(false);
  });

  it('globalKeys.progressOverlay uses g and does not collide with listKeys', () => {
    const progressKeys = new Set<string>(globalKeys.progressOverlay.keys);
    const listKeyValues = Object.values(listKeys).flatMap((b) => b.keys);
    for (const key of listKeyValues) {
      expect(progressKeys.has(key), `listKeys key "${key}" collides with globalKeys.progressOverlay`).toBe(false);
    }
  });

  it('no single-character printable key appears in both globalKeys and listKeys simultaneously', () => {
    // "Printable single char" means length-1 keys (excludes chords like Ctrl+C, arrows like Home/End).
    const isPrintable = (k: string): boolean => k.length === 1;

    const globalPrintable = new Set<string>(
      Object.values(globalKeys)
        .flatMap((b) => b.keys)
        .filter(isPrintable)
    );
    const listPrintable = Object.values(listKeys)
      .flatMap((b) => b.keys)
      .filter(isPrintable);

    for (const key of listPrintable) {
      expect(
        globalPrintable.has(key),
        `printable key "${key}" appears in both globalKeys and listKeys — layers are active simultaneously on list views`
      ).toBe(false);
    }
  });
});

describe('Wave-3 nav chords', () => {
  it('declares cycleSession and jumpSession as global bindings', () => {
    expect(globalKeys.cycleSession.keys).toEqual(['Tab', 'Shift+Tab']);
    expect(globalKeys.jumpSession.keys).toEqual(['Ctrl+1..9']);
  });

  it('keeps the nav chords out of the footer (help overlay only)', () => {
    const footer = hintsFor({ onWorkRoot: true, wide: true, stackDepth: 2, parentLabel: 'Work' }).join(' | ');
    expect(footer).not.toContain('cycle running flow');
    expect(footer).not.toContain('jump to running flow');
  });
});

describe('section keys', () => {
  it('declares 1–5 as a global binding, listed in the help overlay', () => {
    expect(globalKeys.sections.keys).toEqual(['1', '2', '3', '4', '5']);
    const global = keySections.find((sec) => sec.title === 'Global');
    expect(global?.bindings.some((b) => b.keys.includes('1'))).toBe(true);
  });

  it('lists the hidden accelerators under Global', () => {
    const keys = new Set((keySections.find((sec) => sec.title === 'Global')?.bindings ?? []).flatMap((b) => b.keys));
    for (const k of ['h', 'n', 'x', 's', '!', 'S', 'P', 'g']) expect(keys.has(k), k).toBe(true);
  });
});

describe('Scroll section', () => {
  it('is part of keySections', () => {
    expect(keySections.map((s) => s.title)).toContain('Scroll');
  });

  it('shares no printable key with globalKeys', () => {
    const scroll = keySections.find((s) => s.title === 'Scroll');
    const scrollKeys = new Set((scroll?.bindings ?? []).flatMap((b) => b.keys));
    const printable = (k: string): boolean => k.length === 1;
    for (const key of Object.values(globalKeys).flatMap((b) => b.keys)) {
      if (printable(key)) expect(scrollKeys.has(key), `"${key}" is both global and a scroll key`).toBe(false);
    }
  });
});

describe('keySections', () => {
  it('lists every key the context switcher binds, including `n` (new project)', () => {
    const switcher = keySections.find((s) => s.title === 'Context switcher');
    const keys = switcher?.bindings.flatMap((b) => b.keys) ?? [];
    for (const k of ['t', 'f', 'c', 'n', 'esc']) expect(keys).toContain(k);
  });
});
