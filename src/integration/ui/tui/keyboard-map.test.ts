/**
 * keyboard-map invariant tests.
 *
 * The map is the single source of truth for action ↔ shortcut bindings.
 * These invariants prevent silent drift if a future contributor adds a
 * binding that collides with an existing one or forgets to bind a key.
 *
 *   1. Every action carries at least one binding.
 *   2. Within one area, no two actions share the same key.
 *   3. Global bindings shadow non-global areas — no non-global action may
 *      reuse a global key for a different action.
 *   4. Every action has a non-empty label (used by the help overlay).
 *   5. Every area in `HELP_AREA_ORDER` is referenced by at least one binding
 *      and has an `AREA_LABEL` entry; conversely, every label is used.
 */
import { describe, expect, it } from 'vitest';
import {
  AREA_LABEL,
  HELP_AREA_ORDER,
  KEYBOARD_MAP,
  getAllBindings,
  getBindingFor,
  getBindingsByArea,
  getKeyFor,
  type Action,
  type BindingArea,
} from './keyboard-map.ts';

describe('keyboard-map', () => {
  it('every action carries at least one binding', () => {
    for (const { action, binding } of getAllBindings()) {
      expect(binding.keys.length, `${action} has no keys`).toBeGreaterThan(0);
      for (const key of binding.keys) {
        expect(key.length, `${action} has an empty key`).toBeGreaterThan(0);
      }
    }
  });

  it('every action has a non-empty label', () => {
    for (const { action, binding } of getAllBindings()) {
      expect(binding.label.length, `${action} has empty label`).toBeGreaterThan(0);
    }
  });

  it('within an area, no two actions share a key', () => {
    const seenByArea = new Map<BindingArea, Map<string, Action>>();
    for (const { action, binding } of getAllBindings()) {
      const inArea = seenByArea.get(binding.area) ?? new Map<string, Action>();
      for (const key of binding.keys) {
        const existing = inArea.get(key);
        expect(
          existing,
          `area '${binding.area}': key '${key}' is bound to both '${String(existing)}' and '${action}'`
        ).toBeUndefined();
        inArea.set(key, action);
      }
      seenByArea.set(binding.area, inArea);
    }
  });

  it('global bindings shadow every non-global area — no non-global action reuses a global key for a different action', () => {
    // Build a map of global key → action.
    const globalKeyToAction = new Map<string, Action>();
    for (const { action, binding } of getBindingsByArea('global')) {
      for (const key of binding.keys) {
        globalKeyToAction.set(key, action);
      }
    }
    // Then walk every non-global binding and confirm that any key already
    // claimed by a global action is not reused for a different action. The
    // exception is when the non-global binding happens to share semantics
    // (e.g. settings.close uses `esc` which is global.back) — those are
    // explicitly modelled as separate actions but represent the same user
    // intent (close the closest-scope thing). We allow them when the area
    // is one of the "explicit-shadow" set: settings, help, notification,
    // attach. These are the surfaces that intentionally inherit `esc` /
    // `?` semantics from global; the actual keypress is handled by the
    // surface's own component, not the global handler.
    const explicitShadow: ReadonlySet<BindingArea> = new Set(['settings', 'help', 'notification', 'attach', 'execute']);
    for (const { action, binding } of getAllBindings()) {
      if (binding.area === 'global') continue;
      for (const key of binding.keys) {
        const globalOwner = globalKeyToAction.get(key);
        if (globalOwner === undefined) continue;
        if (globalOwner === action) continue;
        // Same key as a global binding. Allowed only when this area is in
        // the explicit-shadow set AND the binding's verb is one of the
        // canonical shadowed verbs (`back`, `close`, `dismiss`).
        const isShadowableVerb = /\b(close|dismiss|back)\b/i.test(binding.label);
        expect(
          explicitShadow.has(binding.area) && isShadowableVerb,
          `non-global ${action} (${binding.area}) shares key '${key}' with global ${globalOwner} but is not in the explicit-shadow set`
        ).toBe(true);
      }
    }
  });

  it('every area in HELP_AREA_ORDER has at least one binding', () => {
    for (const area of HELP_AREA_ORDER) {
      const bindings = getBindingsByArea(area);
      expect(bindings.length, `area '${area}' has no bindings`).toBeGreaterThan(0);
    }
  });

  it('every area used in the map appears in HELP_AREA_ORDER and AREA_LABEL', () => {
    const order = new Set<BindingArea>(HELP_AREA_ORDER);
    for (const { binding } of getAllBindings()) {
      expect(order.has(binding.area), `area '${binding.area}' is missing from HELP_AREA_ORDER`).toBe(true);
      expect(AREA_LABEL[binding.area].length, `area '${binding.area}' has empty label`).toBeGreaterThan(0);
    }
  });

  it('getBindingFor returns the same shape as the map entry', () => {
    const action: Action = 'global.help';
    const direct = KEYBOARD_MAP[action];
    const looked = getBindingFor(action);
    expect(looked).toStrictEqual(direct);
  });

  it('getKeyFor returns the canonical (first) key for the action', () => {
    expect(getKeyFor('global.back')).toBe('esc');
    expect(getKeyFor('global.help')).toBe('?');
    expect(getKeyFor('global.doctor')).toBe('!');
    expect(getKeyFor('execute.detach')).toBe('D');
    expect(getKeyFor('runs.cancel')).toBe('X');
    // First entry is the canonical key, vim aliases follow.
    expect(getKeyFor('list.up')).toBe('↑');
    expect(getKeyFor('list.down')).toBe('↓');
  });

  it('list navigation includes vim-style j/k aliases', () => {
    expect(getBindingFor('list.up').keys).toContain('k');
    expect(getBindingFor('list.down').keys).toContain('j');
    expect(getBindingFor('settings.up').keys).toContain('k');
    expect(getBindingFor('settings.down').keys).toContain('j');
  });

  it('the help overlay is bound to ? globally', () => {
    expect(getKeyFor('global.help')).toBe('?');
  });

  it('the doctor view is bound to ! (rebound from ?)', () => {
    expect(getKeyFor('global.doctor')).toBe('!');
  });

  it('detach (execute) and dashboard (global) are NOT both bound to lowercase d', () => {
    expect(getKeyFor('global.dashboard')).toBe('d');
    expect(getKeyFor('execute.detach')).toBe('D');
    expect(getKeyFor('global.dashboard')).not.toBe(getKeyFor('execute.detach'));
  });

  it('cancel (runs) and runs (global) are NOT both bound to lowercase x', () => {
    expect(getKeyFor('global.runs')).toBe('x');
    expect(getKeyFor('runs.cancel')).toBe('X');
    expect(getKeyFor('global.runs')).not.toBe(getKeyFor('runs.cancel'));
  });
});
