/**
 * `use-flow-launcher.ts`'s post-picker tail: assemble {@link LaunchExtras} from the customize picker's outcome, and
 * persist the skills step's "remember" choice.
 */

import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { createSettingsSetFlow } from '@src/application/flows/settings-set/flow.ts';
import type { FlowEntry } from '@src/application/registry.ts';
import {
  buildSkillCandidates,
  flowMountsSkills,
  type LaunchExtras,
  type LauncherDeps,
  type SkillCandidatesResult,
} from '@src/application/ui/shared/launcher.ts';
import { skillsForFlow } from '@src/integration/ai/skills/_engine/registry.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { getImplementRoleOverrides } from '@src/application/ui/tui/runtime/implement-role-overrides.ts';
import type { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import type { CustomizePickerResult } from '@src/application/ui/tui/views/flows-customize-picker.ts';
import type { AiProvider, AiSkillsSettings, Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';

/**
 * Pre-fetch skill candidates BEFORE the picker runs — only for a flow whose launch context actually threads a
 * `skillSource` ({@link flowMountsSkills}).
 */
export const prefetchSkillCandidates = (
  launcherDeps: LauncherDeps,
  snapshot: AppStateSnapshot,
  flowId: string,
  settings: Settings
): Promise<SkillCandidatesResult | undefined> =>
  flowMountsSkills(flowId)
    ? buildSkillCandidates(launcherDeps, snapshot, flowId, settings)
    : Promise.resolve(undefined);

/**
 * Closure the picker calls to re-list candidates for a provider its row walk just picked — operator drop-ins are
 * provider-scoped.
 */
export const makeRebuildSkillCandidates =
  (launcherDeps: LauncherDeps, snapshot: AppStateSnapshot, flowId: string, settings: Settings) =>
  (provider: AiProvider): Promise<SkillCandidatesResult | undefined> =>
    buildSkillCandidates(launcherDeps, snapshot, flowId, settings, provider);

/**
 * Assemble the per-launch {@link LaunchExtras} from the resolved repository id, the customize picker's outcome, and
 * the fresh settings snapshot.
 */
export const buildLaunchExtras = (
  picker: CustomizePickerResult,
  entry: FlowEntry,
  chosenRepositoryId: RepositoryId | undefined,
  ui: ReturnType<typeof useUiState>,
  settings: Settings
): LaunchExtras => {
  const implementRoleOverrides =
    picker.kind === 'implement'
      ? picker.implementRoleOverrides
      : entry.manifest.id === 'implement'
        ? getImplementRoleOverrides()
        : undefined;
  const override = picker.kind === 'single' ? picker.override : undefined;
  const skills = picker.kind !== 'cancel' ? picker.skills : undefined;
  const skillsOverride = skills !== undefined ? { disabled: skills.disabled } : undefined;
  // Thread the resolved repository id as a pre-selection.
  const repositoryId = chosenRepositoryId ?? ui.sessionRepositoryId;
  return {
    ...(repositoryId !== undefined ? { repositoryId } : {}),
    ...(override !== undefined ? { override } : {}),
    ...(implementRoleOverrides !== undefined ? { implementRoleOverrides } : {}),
    ...(skillsOverride !== undefined ? { skillsOverride } : {}),
    settingsSnapshot: settings,
  };
};

/** Persist the "remember" half of the skills step. */
const persistSkillsDefault = async (
  settingsRepo: AppDeps['settingsRepo'],
  settings: Settings,
  settingsFlow: FlowId,
  disabled: readonly string[]
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
  const skills: AiSkillsSettings = { ...settings.ai.skills, [settingsFlow]: { disabled } };
  const nextSettings: Settings = {
    ...settings,
    ai: { ...settings.ai, skills } as Settings['ai'],
  };
  const saved = await createSettingsSetFlow({ settingsRepo }).execute({ input: { next: nextSettings } });
  if (!saved.ok) return { ok: false, message: saved.error.error.message };
  return { ok: true };
};

/** Drive the picker's "remember" choice, if any. */
export const applySkillsRememberChoice = async (
  settingsRepo: AppDeps['settingsRepo'],
  settings: Settings,
  skillCandidates: SkillCandidatesResult | undefined,
  picker: CustomizePickerResult
): Promise<string | undefined> => {
  if (picker.kind === 'cancel' || picker.skills?.saveAsDefault !== true) return undefined;
  if (skillCandidates?.settingsFlow === undefined) return undefined;
  if (skillCandidates.degraded) {
    return "Skills listing was incomplete — preference not saved (this run's choice still applies).";
  }

  const settingsFlow = skillCandidates.settingsFlow;
  const registryDefaults = new Set(skillsForFlow(settingsFlow));
  const previouslySaved = settings.ai.skills?.[settingsFlow]?.disabled ?? [];
  const handAdded = previouslySaved.filter((name) => !registryDefaults.has(name));
  const uncheckedDefaults = picker.skills.disabled.filter((name) => registryDefaults.has(name));
  const disabled = [...new Set([...handAdded, ...uncheckedDefaults])];

  const persisted = await persistSkillsDefault(settingsRepo, settings, settingsFlow, disabled);
  return persisted.ok ? undefined : `Couldn't remember skills preference: ${persisted.message}`;
};
