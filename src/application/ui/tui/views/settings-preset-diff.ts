/**
 * Pure before/after of applying a preset: every value a preset can rewrite (`ai.*` leaves plus the
 * two harness flags it stamps), compared against what `applyPreset` would produce.
 */

import { applyPreset, type PresetName } from '@src/business/settings/presets.ts';
import type { Settings } from '@src/domain/entity/settings.ts';

export interface SettingChange {
  readonly setting: string;
  readonly now: string;
  readonly after: string;
}

export interface SettingsDiff {
  readonly changed: readonly SettingChange[];
  /** Paths of the compared values that already match. */
  readonly unchanged: readonly string[];
}

const UNSET = '(default)';

const flatten = (value: unknown, path: string, out: Map<string, string>): void => {
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) flatten(child, path === '' ? key : `${path}.${key}`, out);
    return;
  }
  out.set(path, String(value));
};

const comparable = (settings: Settings): Map<string, string> => {
  const out = new Map<string, string>();
  flatten(settings.ai, 'ai', out);
  out.set('harness.escalateOnPlateau', String(settings.harness.escalateOnPlateau));
  out.set('harness.bestOfNCandidates', String(settings.harness.bestOfNCandidates));
  return out;
};

export const diffSettings = (current: Settings, next: Settings): SettingsDiff => {
  const before = comparable(current);
  const after = comparable(next);
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  const changed: SettingChange[] = [];
  const unchanged: string[] = [];
  for (const key of keys) {
    const now = before.get(key) ?? UNSET;
    const then = after.get(key) ?? UNSET;
    if (now === then) unchanged.push(key);
    else changed.push({ setting: key, now, after: then });
  }
  return { changed, unchanged };
};

export const diffPreset = (name: PresetName, current: Settings): SettingsDiff =>
  diffSettings(current, applyPreset(name, current));
