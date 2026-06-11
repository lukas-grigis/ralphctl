/**
 * submitField — escalation-map routing.
 *
 * `map-add` submits a `from=to` pair from the two-step picker; `map-entry` submits a bare
 * target where the empty string deletes the override. Both must persist through the same
 * `harness.escalationMap.<from>` apply-key grammar the CLI's `settings set` uses.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import { submitField } from '@src/application/ui/tui/views/settings-mutations.ts';
import type { EditableField } from '@src/application/ui/tui/views/settings-view-model.ts';

const recordingRepo = (): { readonly repo: SettingsRepository; readonly saved: () => Settings | undefined } => {
  let saved: Settings | undefined;
  return {
    saved: () => saved,
    repo: {
      path: '/tmp/test-settings.json',
      async exists() {
        return Result.ok(true);
      },
      async load() {
        return Result.ok(saved ?? DEFAULT_SETTINGS);
      },
      async save(next: Settings) {
        saved = next;
        return Result.ok(undefined);
      },
    } as unknown as SettingsRepository,
  };
};

const mapAddField: EditableField = {
  kind: 'map-add',
  key: 'harness.escalationMap',
  label: 'Escalation map',
  current: 'defaults apply',
};

const mapEntryField = (from: string, to: string): EditableField => ({
  kind: 'map-entry',
  key: `harness.escalationMap.${from}`,
  label: `  ${from}`,
  current: to,
  from,
  to,
});

describe('submitField — escalation map', () => {
  it('map-add persists the from=to pair as a new override', async () => {
    const { repo, saved } = recordingRepo();
    const outcome = await submitField(DEFAULT_SETTINGS, mapAddField, 'claude-opus-4-8=claude-fable-5', repo);

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.text).toContain('claude-opus-4-8');
    expect(saved()?.harness.escalationMap).toEqual({ 'claude-opus-4-8': 'claude-fable-5' });
  });

  it('map-add rejects a malformed pair without persisting', async () => {
    const { repo, saved } = recordingRepo();
    const outcome = await submitField(DEFAULT_SETTINGS, mapAddField, 'not-a-pair', repo);

    expect(outcome.kind).toBe('error');
    expect(saved()).toBeUndefined();
  });

  it('map-entry with a new target updates the override in place', async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, escalationMap: { 'claude-opus-4-8': 'claude-fable-5' } },
    };
    const { repo, saved } = recordingRepo();
    const outcome = await submitField(
      settings,
      mapEntryField('claude-opus-4-8', 'claude-fable-5'),
      'claude-fable-5[1m]',
      repo
    );

    expect(outcome.kind).toBe('ok');
    expect(saved()?.harness.escalationMap).toEqual({ 'claude-opus-4-8': 'claude-fable-5[1m]' });
  });

  it('map-entry with the empty string removes the override', async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, escalationMap: { 'claude-opus-4-8': 'claude-fable-5' } },
    };
    const { repo, saved } = recordingRepo();
    const outcome = await submitField(settings, mapEntryField('claude-opus-4-8', 'claude-fable-5'), '', repo);

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.text).toContain('removed');
    expect(saved()?.harness.escalationMap).toEqual({});
  });
});
