/**
 * Settings view-model — escalation-map field group + pure helpers.
 *
 * The harness section exposes the map as an editable group: one `map-add` action row plus one
 * `map-entry` row per user override. Target options are scoped to the catalogs that know the
 * from-model so the picker never invites cross-provider ids; the effective-ladder summary
 * merges user overrides over the built-in map and marks customised chains.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import {
  buildSections,
  effectiveEscalationChains,
  escalationModelOptions,
  escalationTargetsFor,
} from '@src/application/ui/tui/views/settings-view-model.ts';

const withOverrides = (escalationMap: Readonly<Record<string, string>>): Settings => ({
  ...DEFAULT_SETTINGS,
  harness: { ...DEFAULT_SETTINGS.harness, escalationMap },
});

const harnessFields = (s: Settings): ReturnType<typeof buildSections>[number]['fields'] => {
  const section = buildSections(s).find((sec) => sec.id === 'harness');
  if (section === undefined) throw new Error('harness section missing');
  return section.fields;
};

describe('buildSections — escalation-map group', () => {
  it('exposes a single map-add row (and no entries) when no overrides exist', () => {
    const fields = harnessFields(DEFAULT_SETTINGS);
    const add = fields.filter((f) => f.kind === 'map-add');
    expect(add).toHaveLength(1);
    expect(add[0]?.key).toBe('harness.escalationMap');
    expect(add[0]?.current).toContain('defaults apply');
    expect(fields.some((f) => f.kind === 'map-entry')).toBe(false);
  });

  it('exposes one editable map-entry row per override, keyed on the CLI grammar', () => {
    const fields = harnessFields(withOverrides({ 'claude-opus-4-8': 'claude-fable-5' }));
    const entries = fields.filter((f) => f.kind === 'map-entry');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe('harness.escalationMap.claude-opus-4-8');
    expect(entries[0]?.from).toBe('claude-opus-4-8');
    expect(entries[0]?.to).toBe('claude-fable-5');
    const add = fields.find((f) => f.kind === 'map-add');
    expect(add?.current).toContain('1 override');
  });
});

describe('escalation model helpers', () => {
  it('escalationModelOptions unions the three catalogs without duplicates', () => {
    const options = escalationModelOptions();
    expect(options).toContain('claude-opus-4-8');
    expect(new Set(options).size).toBe(options.length);
  });

  it('escalationTargetsFor scopes targets to catalogs owning the from-model and excludes self', () => {
    const targets = escalationTargetsFor('claude-haiku-4-5');
    expect(targets).toContain('claude-sonnet-4-6');
    expect(targets).toContain('claude-opus-4-8');
    expect(targets).not.toContain('claude-haiku-4-5');
    // Dash-form Claude ids live in the Claude-Code catalog only — no GPT ids offered.
    expect(targets.some((t) => t.startsWith('gpt-'))).toBe(false);
  });

  it('escalationTargetsFor falls back to the full union for a custom (uncatalogued) id', () => {
    const targets = escalationTargetsFor('my-private-model');
    expect(targets).toContain('claude-opus-4-8');
    expect(targets.some((t) => t.startsWith('gpt-'))).toBe(true);
  });
});

describe('effectiveEscalationChains', () => {
  it('renders the built-in haiku→sonnet→opus chain uncustomised with no overrides', () => {
    const chains = effectiveEscalationChains({});
    const claude = chains.find((c) => c.models[0] === 'claude-haiku-4-5');
    expect(claude?.models).toEqual(['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8']);
    expect(claude?.customised).toBe(false);
  });

  it('extends a chain through a user rung and marks it customised', () => {
    const chains = effectiveEscalationChains({ 'claude-opus-4-8': 'claude-fable-5' });
    const claude = chains.find((c) => c.models[0] === 'claude-haiku-4-5');
    expect(claude?.models).toEqual(['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5']);
    expect(claude?.customised).toBe(true);
  });

  it('cuts user-authored cycles instead of walking forever', () => {
    const chains = effectiveEscalationChains({ 'model-a': 'model-b', 'model-b': 'model-a' });
    // Both rungs are targets of each other, so neither is a root — the cycle simply never
    // surfaces as a chain. The default chains still render.
    expect(chains.some((c) => c.models[0] === 'claude-haiku-4-5')).toBe(true);
    expect(chains.every((c) => new Set(c.models).size === c.models.length)).toBe(true);
  });
});
