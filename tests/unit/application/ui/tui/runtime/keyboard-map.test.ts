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
import { footerGlobalHints, globalKeys, type KeyBinding } from '@src/application/ui/tui/runtime/keyboard-map.ts';

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
      'pick sprint',
      'help',
      'quit',
    ]);
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
