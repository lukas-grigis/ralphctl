import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { skillsForFlow } from '@src/integration/ai/skills/_engine/registry.ts';
import type { SkillCandidatesResult } from '@src/application/ui/shared/launcher.ts';
import type { CustomizePickerResult } from '@src/application/ui/tui/views/flows-customize-picker.ts';
import { applySkillsRememberChoice, buildLaunchExtras } from '@src/application/ui/tui/views/flows-launch-extras.ts';
import type { FlowEntry } from '@src/application/registry.ts';
import type { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

const repoFor = (initial: Settings, failSave = false): { repo: SettingsRepository; saved: { value?: Settings } } => {
  const saved: { value?: Settings } = {};
  const repo: SettingsRepository = {
    path: '/tmp/settings.json',
    async exists() {
      return Result.ok(true);
    },
    async load() {
      return Result.ok(initial);
    },
    async save(next) {
      if (failSave) return Result.error(new Error('disk full') as never);
      saved.value = next;
      return Result.ok(undefined);
    },
  };
  return { repo, saved };
};

// Real registry names keep this test honest against the actual default set.
const IMPLEMENT_DEFAULTS = skillsForFlow('implement');
const DEFAULT_A = IMPLEMENT_DEFAULTS[0]!;
const DEFAULT_B = IMPLEMENT_DEFAULTS[1]!;

const candidatesFor = (overrides?: Partial<SkillCandidatesResult>): SkillCandidatesResult => ({
  settingsFlow: 'implement',
  candidates: [
    { name: DEFAULT_A, description: 'a', origin: 'bundled-default' },
    // A phase-folder COPY of a bundled default — post-dedupe its origin is phase-folder, but by
    // NAME it is still a registry default and its uncheck must persist.
    { name: DEFAULT_B, description: 'b (shadowed copy)', origin: 'phase-folder' },
    { name: 'ralphctl-opted-in-extra', description: 'catalog opt-in', origin: 'phase-folder' },
  ],
  savedDisabled: [],
  degraded: false,
  ...overrides,
});

const rememberPicker = (disabled: readonly string[]): CustomizePickerResult => ({
  kind: 'defaults',
  skills: { disabled, saveAsDefault: true },
});

const settingsWithSaved = (disabled: readonly string[]): Settings =>
  ({
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, skills: { implement: { disabled } } },
  }) as Settings;

describe('applySkillsRememberChoice — merge-preserve persistence', () => {
  it('persists unchecked registry defaults by NAME, including a phase-shadowed bundled copy', async () => {
    const { repo, saved } = repoFor(DEFAULT_SETTINGS);
    const warning = await applySkillsRememberChoice(
      repo,
      DEFAULT_SETTINGS,
      candidatesFor(),
      rememberPicker([DEFAULT_A, DEFAULT_B, 'ralphctl-opted-in-extra'])
    );
    expect(warning).toBeUndefined();
    const row = saved.value?.ai.skills?.implement?.disabled ?? [];
    expect(row).toContain(DEFAULT_A);
    expect(row).toContain(DEFAULT_B); // by name, despite phase-folder origin
    expect(row).not.toContain('ralphctl-opted-in-extra'); // non-default unchecks stay run-scoped
  });

  it('preserves hand-added non-default names and drops re-checked defaults', async () => {
    const settings = settingsWithSaved(['ralphctl-hand-added', DEFAULT_A]);
    const { repo, saved } = repoFor(settings);
    // The user unchecked nothing this run — every default is re-checked.
    const warning = await applySkillsRememberChoice(repo, settings, candidatesFor(), rememberPicker([]));
    expect(warning).toBeUndefined();
    const row = saved.value?.ai.skills?.implement?.disabled ?? [];
    expect(row).toContain('ralphctl-hand-added'); // survives the rewrite
    expect(row).not.toContain(DEFAULT_A); // re-checked → removed
  });

  it('is a no-op for run-only, cancel, and missing candidates', async () => {
    const { repo, saved } = repoFor(DEFAULT_SETTINGS);
    const runOnly: CustomizePickerResult = {
      kind: 'defaults',
      skills: { disabled: [DEFAULT_A], saveAsDefault: false },
    };
    expect(await applySkillsRememberChoice(repo, DEFAULT_SETTINGS, candidatesFor(), runOnly)).toBeUndefined();
    expect(
      await applySkillsRememberChoice(repo, DEFAULT_SETTINGS, candidatesFor(), { kind: 'cancel' })
    ).toBeUndefined();
    expect(
      await applySkillsRememberChoice(repo, DEFAULT_SETTINGS, undefined, rememberPicker([DEFAULT_A]))
    ).toBeUndefined();
    expect(saved.value).toBeUndefined();
  });

  it('refuses to persist over a degraded candidate listing', async () => {
    const settings = settingsWithSaved([DEFAULT_A]);
    const { repo, saved } = repoFor(settings);
    const warning = await applySkillsRememberChoice(
      repo,
      settings,
      candidatesFor({ degraded: true, candidates: [] }),
      rememberPicker([])
    );
    expect(warning).toMatch(/not saved/i);
    expect(saved.value).toBeUndefined(); // the saved opt-out was NOT wiped
  });

  it('surfaces a save failure as a soft warning', async () => {
    const { repo } = repoFor(DEFAULT_SETTINGS, true);
    const warning = await applySkillsRememberChoice(
      repo,
      DEFAULT_SETTINGS,
      candidatesFor(),
      rememberPicker([DEFAULT_A])
    );
    expect(warning).toMatch(/Couldn't remember/i);
  });
});

describe('buildLaunchExtras — skillsOverride mapping', () => {
  const entry = { manifest: { id: 'refine', title: 'Refine' } } as FlowEntry;
  const ui = { sessionRepositoryId: undefined } as unknown as ReturnType<typeof useUiState>;

  it('maps picker skills.disabled to skillsOverride, including the empty re-enable case', () => {
    const withDisables = buildLaunchExtras(rememberPicker([DEFAULT_A]), entry, undefined, ui, DEFAULT_SETTINGS);
    expect(withDisables.skillsOverride).toEqual({ disabled: [DEFAULT_A] });
    // Empty array is a REAL override (re-enables every remembered-off skill for this run).
    const emptyOverride = buildLaunchExtras(rememberPicker([]), entry, undefined, ui, DEFAULT_SETTINGS);
    expect(emptyOverride.skillsOverride).toEqual({ disabled: [] });
  });

  it('omits skillsOverride when the skills step was kept at default', () => {
    const kept = buildLaunchExtras({ kind: 'defaults' }, entry, undefined, ui, DEFAULT_SETTINGS);
    expect(kept.skillsOverride).toBeUndefined();
  });
});
