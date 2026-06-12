/**
 * Pure-data tests for the centralised keyboard map — specifically the derived footer-hint
 * subset and the Wave-3 nav chords.
 *
 * These pin down the invariants the status bar relies on so the footer can stop hand-maintaining
 * a parallel hint list:
 *  - every `footerGlobalHints` entry traces back to a real `globalKeys` binding tagged
 *    `showInFooter` (no orphaned / stale hints);
 *  - no footer hint references a key the canonical binding does not declare;
 *  - the Wave-3 nav chords (`cycleSession` / `jumpSession`) exist as global bindings but stay out
 *    of the footer (help-overlay only).
 */

import { describe, expect, it } from 'vitest';
import {
  footerGlobalHints,
  globalKeys,
  listKeys,
  type KeyBinding,
} from '@src/application/ui/tui/runtime/keyboard-map.ts';

describe('footerGlobalHints', () => {
  it('maps every entry to a real globalKeys binding tagged showInFooter', () => {
    const footerEligible = (Object.values(globalKeys) as KeyBinding[]).filter((b) => b.showInFooter === true);

    // One footer hint per footer-eligible binding — no extras, no drops.
    expect(footerGlobalHints).toHaveLength(footerEligible.length);

    for (const hint of footerGlobalHints) {
      const match = footerEligible.find((b) => b.label === hint.label);
      expect(match, `footer hint "${hint.label}" must map to a showInFooter binding`).toBeDefined();
      // The hint's keys string must be the canonical binding's keys, joined — no unknown keys.
      expect(hint.keys).toBe(match?.keys.join('/'));
    }
  });

  it('references no key the canonical binding does not declare', () => {
    const knownKeys = new Set<string>(Object.values(globalKeys).flatMap((b) => b.keys));
    for (const hint of footerGlobalHints) {
      for (const key of hint.keys.split('/')) {
        expect(knownKeys.has(key), `footer hint key "${key}" is not a declared global key`).toBe(true);
      }
    }
  });

  it('covers exactly the curated footer subset', () => {
    expect(footerGlobalHints.map((h) => h.label)).toEqual([
      'back',
      'home',
      'new flow',
      'sessions',
      'settings',
      'pick project',
      'help',
      'quit',
    ]);
  });

  it('keeps pick sprint out of the footer (breadcrumb [S] owns discoverability; the strip overflows 100 cols otherwise)', () => {
    expect((globalKeys.pickSprint as KeyBinding).showInFooter).toBeUndefined();
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
    expect((globalKeys.cycleSession as KeyBinding).showInFooter).toBeUndefined();
    expect((globalKeys.jumpSession as KeyBinding).showInFooter).toBeUndefined();
    const footerLabels = footerGlobalHints.map((h) => h.label);
    expect(footerLabels).not.toContain('cycle running flow');
    expect(footerLabels).not.toContain('jump to running flow');
  });
});
