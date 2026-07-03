/**
 * `flows-view.tsx`'s post-picker tail: assemble {@link LaunchExtras} from the customize picker's
 * outcome, and persist the skills step's "remember" choice. Split out of the view so the click
 * handler's cyclomatic complexity and the file's line budget both stay under the lint ratchet —
 * mirrors the existing `flows-repository-picker.ts` pattern of a small, view-scoped helper module
 * the view imports rather than inlining.
 *
 * The picker never writes settings itself (see `flows-customize-picker.ts`'s module doc); this is
 * where a `saveAsDefault: true` skills choice actually persists.
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
 * Pre-fetch skill candidates BEFORE the picker runs — only for a flow whose launch context
 * actually threads a `skillSource` ({@link flowMountsSkills}); every other flow skips the async
 * directory-listing round-trip entirely (the picker's skills step is a no-op without it).
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
 * Closure the picker calls to re-list candidates for a provider its row walk just picked —
 * operator drop-ins are provider-scoped, so the prefetched (saved-provider) snapshot can be
 * stale the moment the user overrides the provider for the run.
 */
export const makeRebuildSkillCandidates =
  (launcherDeps: LauncherDeps, snapshot: AppStateSnapshot, flowId: string, settings: Settings) =>
  (provider: AiProvider): Promise<SkillCandidatesResult | undefined> =>
    buildSkillCandidates(launcherDeps, snapshot, flowId, settings, provider);

/**
 * Assemble the per-launch {@link LaunchExtras} from the resolved repository id, the customize
 * picker's outcome, and the fresh settings snapshot. Implement role overrides prefer the picker's
 * per-role result; falling back to the CLI-derived module holder (parsed from
 * `--implement-{generator,evaluator}-{provider,model}`) only for the `implement` flow when the
 * picker ran in single-row mode (i.e. every AI flow other than implement).
 *
 * `skillsOverride` maps 1:1 from the picker's `skills.disabled` — present whenever the skills step
 * ran and the user didn't just keep the default, REGARDLESS of whether `saveAsDefault` is also
 * true. The run must not depend on the save round-trip: even when the caller persists a
 * "remember" choice, this run still gets its override directly from the picker result.
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
  // Thread the resolved repository id as a pre-selection. When the repo-selection step ran,
  // `chosenRepositoryId` is the user's fresh pick; otherwise (single-repo / non-repo flows) it
  // falls back to the session pin so the flow's own `pickRepositoryLeaf` still pre-selects the
  // lone / previously-chosen repo.
  const repositoryId = chosenRepositoryId ?? ui.sessionRepositoryId;
  return {
    ...(repositoryId !== undefined ? { repositoryId } : {}),
    ...(override !== undefined ? { override } : {}),
    ...(implementRoleOverrides !== undefined ? { implementRoleOverrides } : {}),
    ...(skillsOverride !== undefined ? { skillsOverride } : {}),
    settingsSnapshot: settings,
  };
};

/**
 * Persist the "remember" half of the skills step. A full read-modify-write of the already-loaded
 * `settings` via the same `settings-set` seam every other TUI mutation uses
 * (`settings-mutations.ts`'s `persistKey`).
 */
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

/**
 * Drive the picker's "remember" choice, if any. No-op (returns `undefined`) when the user kept
 * skills at default, picked "run only", the flow never surfaced candidates in the first place, or
 * the candidate listing came back degraded (a complement computed over a partial list must never
 * overwrite the saved row). Non-fatal on failure — the run itself already carries the full
 * override via {@link buildLaunchExtras}'s `skillsOverride`, independent of whether this save
 * succeeds; the caller surfaces the returned message as a soft warning and proceeds regardless.
 *
 * What persists is decided by NAME against the registry (`skillsForFlow`), not by candidate
 * origin — a phase-folder copy shadowing a bundled default still counts as that default. The
 * saved row is merged, not replaced: previously saved names OUTSIDE the flow's registry defaults
 * (hand-added entries) survive; registry-default names the user re-checked drop out; only
 * registry-default names the user unchecked are (re)added. Project / operator / phase-folder
 * unchecks stay run-scoped — those sources are runtime-dependent (per-repo, per-provider,
 * per-catalog-enable), so a durable opt-out for them would be scoped confusingly.
 */
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
