/**
 * Pre-launch customize picker used by `flows-view.tsx`. For an AI-driven flow the user chooses
 * `Start (use defaults)`, `Customize for this run…` or `Cancel`. Customize walks provider → model →
 * effort with `Keep default` first on each step (implement: generator, then evaluator), followed by
 * one flow-level skills step when {@link SkillCandidatesResult} is supplied. The picker only reads
 * {@link Settings} and never saves: a "remember" choice on the skills step is surfaced on the result
 * for `flows-view.tsx` to persist.
 *
 * Standalone so tests can drive it with a scripted {@link InteractivePrompt} without mounting Ink.
 */

import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import {
  type AiFlowSettings,
  type AiImplementRole,
  type AiProvider,
  primaryFlowRow,
  type Settings,
  AI_PROVIDERS,
} from '@src/domain/entity/settings.ts';
import { PROVIDER_EFFORT_LEVELS } from '@src/domain/value/settings-models/effort.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';
import { isSuspendedModel, SUSPENSION_NOTE } from '@src/domain/value/settings-models/suspended-models.ts';
import { contextWindowLabel } from '@src/domain/value/settings-models/context-window.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { resolveEffortForRow } from '@src/business/settings/resolve-effort.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import type { LaunchExtras, SkillCandidate, SkillCandidatesResult } from '@src/application/ui/shared/launcher.ts';
import { aiFlowIdFor } from '@src/application/ui/shared/launch/ai-flow-id.ts';

/** Sentinel value returned for the `Keep default` option — never collides with a real id. */
const KEEP = '__keep__';

type RowOverride = NonNullable<LaunchExtras['override']>;

/**
 * Map a model id to a picker choice. Context-window size and the suspension note go on the LABEL
 * only — the `value` stays the bare id so a pre-pinned choice round-trips (a suspended pick is
 * rejected by the adapter guard at launch).
 *
 *   'claude-sonnet-4-6'   →  'claude-sonnet-4-6  ·  200K'
 *   'gpt-5.5'             →  'gpt-5.5'   (no window known — no annotation)
 */
const modelChoice = (m: string): Choice<string> => {
  const windowPart = contextWindowLabel(m);
  const suspendedPart = isSuspendedModel(m) ? `(${SUSPENSION_NOTE})` : undefined;
  const annotations = [windowPart, suspendedPart].filter((s): s is string => s !== undefined);
  const label = annotations.length > 0 ? `${m}  ${glyphs.bullet}  ${annotations.join('  ')}` : m;
  return { label, value: m };
};

/**
 * Outcome of the skills step, carried on every non-cancel result. `disabled` is the full per-run
 * disable set; `saveAsDefault` asks `flows-view.tsx` to persist its registry-default subset (see
 * `applySkillsRememberChoice` in `flows-launch-extras.ts`). Absent `skills` means the skill set was
 * kept.
 */
export interface SkillsCustomizeResult {
  readonly disabled: readonly string[];
  readonly saveAsDefault: boolean;
}

/**
 * Outcome of one picker session:
 *   - `cancel`: Esc / Cancel at any step — do NOT launch
 *   - `defaults`: Start, or customized with every row kept — launch with no row override
 *     (`skills` may still be set; that step runs independently)
 *   - `single`: non-implement customize; `override` is the per-field diff
 *   - `implement`: implement customize; `implementRoleOverrides` carries each role independently
 */
export type CustomizePickerResult =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'defaults'; readonly skills?: SkillsCustomizeResult }
  | { readonly kind: 'single'; readonly override: RowOverride; readonly skills?: SkillsCustomizeResult }
  | {
      readonly kind: 'implement';
      readonly implementRoleOverrides: NonNullable<LaunchExtras['implementRoleOverrides']>;
      readonly skills?: SkillsCustomizeResult;
    };

/** The AI settings row that owns a flow's session; `undefined` skips the picker (create-pr has no picker). */
const aiFlowIdForPicker = (flowId: string): FlowId | undefined =>
  flowId === 'create-pr' ? undefined : aiFlowIdFor(flowId);

/** The single row the picker presents as default for a non-implement flow (review shows `implement.generator`). */
const defaultRowFor = (flowId: string, settings: Settings): AiFlowSettings | undefined => {
  const aiFlow = aiFlowIdForPicker(flowId);
  return aiFlow === undefined ? undefined : primaryFlowRow(settings.ai, aiFlow);
};

const labelKeepDefault = (value: string | undefined): string => `Keep default (${value ?? 'unset'})`;

const formatRow = (row: AiFlowSettings, globalEffort: Settings['ai']['effort'], flow: FlowId): string =>
  `${row.provider} / ${row.model} / ${resolveEffortForRow(row, globalEffort, flow) ?? 'auto'}`;

/**
 * `Keep default` label for the effort step. After a provider switch the saved effort may not exist
 * in the new vocabulary, so no concrete value is promised. After a model-only change the saved
 * effort would be silently inherited (sonnet @ xhigh is the worst wall-clock combination), so the
 * label names the value and whether it comes from the saved row or the global default.
 */
const effortKeepLabel = (
  defaultRow: AiFlowSettings,
  globalEffort: Settings['ai']['effort'],
  providerChanged: boolean,
  modelChanged: boolean,
  resolvedRowEffort: string | undefined
): string => {
  if (providerChanged) return 'Keep default';
  if (!modelChanged) return labelKeepDefault(resolvedRowEffort ?? 'auto');
  const source = defaultRow.effort !== undefined ? 'saved row' : globalEffort !== undefined ? 'global' : '';
  const shown = resolvedRowEffort ?? 'auto';
  return source.length > 0 ? `Keep default (${shown} — ${source})` : `Keep default (${shown})`;
};

/** What every row walk needs; built once per picker session. */
interface PickerContext {
  readonly interactive: InteractivePrompt;
  readonly header: string;
  readonly globalEffort: Settings['ai']['effort'];
  readonly flow: FlowId;
  readonly availableModelsFor: ((provider: AiProvider) => Promise<readonly string[]>) | undefined;
}

/**
 * Walk one row through provider → model → effort. Returns only the fields the user changed
 * (empty when everything was kept), or `undefined` when the user cancels at any step.
 */
const customizeRow = async (
  { interactive, header, globalEffort, flow, availableModelsFor }: PickerContext,
  defaultRow: AiFlowSettings
): Promise<RowOverride | undefined> => {
  const providerAns = await interactive.askChoice<string>(`${header}\nProvider:`, [
    { label: labelKeepDefault(defaultRow.provider), value: KEEP },
    ...AI_PROVIDERS.map((p) => ({ label: p, value: p })),
  ]);
  if (!providerAns.ok) return undefined;
  const providerChanged = providerAns.value !== KEEP && providerAns.value !== defaultRow.provider;
  const provider: AiProvider = providerChanged ? (providerAns.value as AiProvider) : defaultRow.provider;

  // After a provider switch the saved model belongs to another catalog, so `Keep default` is withheld.
  const catalog = availableModelsFor ? await availableModelsFor(provider) : PROVIDER_TRAITS[provider].modelCatalog;
  const modelAns = await interactive.askChoice<string>(`${header}\nModel:`, [
    ...(providerChanged ? [] : [{ label: labelKeepDefault(defaultRow.model), value: KEEP }]),
    ...catalog.map(modelChoice),
  ]);
  if (!modelAns.ok) return undefined;
  const model = modelAns.value;
  const modelChanged = model !== KEEP && model !== defaultRow.model;

  const effortAns = await interactive.askChoice<string>(`${header}\nEffort:`, [
    {
      label: effortKeepLabel(
        defaultRow,
        globalEffort,
        providerChanged,
        modelChanged,
        resolveEffortForRow(defaultRow, globalEffort, flow)
      ),
      value: KEEP,
    },
    ...PROVIDER_EFFORT_LEVELS[provider].map((e) => ({ label: e, value: e })),
  ]);
  if (!effortAns.ok) return undefined;

  // A provider switch always carries a model: the launcher cannot merge one from the old catalog.
  return {
    ...(providerChanged ? { provider } : {}),
    ...(modelChanged || providerChanged ? { model } : {}),
    ...(effortAns.value !== KEEP ? { effort: effortAns.value } : {}),
  };
};

export interface RunCustomizePickerArgs {
  readonly interactive: InteractivePrompt;
  readonly flowId: string;
  readonly flowTitle: string;
  readonly settings: Settings;
  /**
   * Per-provider availability lookup (`AppDeps.availableModelsFor`). Present: the model step shows
   * only the account's models. Absent (tests): the full static catalog.
   */
  readonly availableModelsFor?: (provider: AiProvider) => Promise<readonly string[]>;
  /**
   * Skill candidates for this flow, pre-built by `launcher.ts`'s `buildSkillCandidates` (the picker
   * is never given `AppDeps`). Absent or empty skips the skills step.
   */
  readonly skillCandidates?: SkillCandidatesResult;
  /**
   * Re-fetch candidates for the provider the row walk picked: operator drop-in skills are
   * provider-scoped, so the prefetched snapshot (saved provider) can be wrong after an override. A
   * failed or degraded rebuild falls back to the prefetched snapshot.
   */
  readonly rebuildSkillCandidates?: (provider: AiProvider) => Promise<SkillCandidatesResult | undefined>;
}

/** Header shown on every prompt frame: implement renders both roles, everything else the single row. */
const buildPickerHeader = (flowId: string, flowTitle: string, settings: Settings, aiFlow: FlowId): string =>
  flowId === 'implement'
    ? `${flowTitle} — current defaults:\n  generator: ${formatRow(settings.ai.implement.generator, settings.ai.effort, aiFlow)}\n  evaluator: ${formatRow(settings.ai.implement.evaluator, settings.ai.effort, aiFlow)}`
    : `${flowTitle} — current default: ${formatRow(defaultRowFor(flowId, settings)!, settings.ai.effort, aiFlow)}`;

const ORIGIN_LABEL: Readonly<Record<SkillCandidate['origin'], string>> = {
  'bundled-default': 'default',
  'phase-folder': 'opt-in folder',
  project: 'project',
  operator: 'operator',
};

type RebuildSkillCandidates = NonNullable<RunCustomizePickerArgs['rebuildSkillCandidates']>;

/** Skills-step inputs bundled so both customize paths thread one bag. */
interface SkillsStepInput {
  readonly candidates?: SkillCandidatesResult;
  readonly rebuild?: RebuildSkillCandidates;
}

/** Candidates the skills step lists: the rebuilt set for an overridden provider, else the prefetched snapshot. */
const effectiveSkillCandidates = async (
  { candidates, rebuild }: SkillsStepInput,
  overriddenProvider: AiProvider | undefined
): Promise<SkillCandidatesResult | undefined> => {
  if (candidates === undefined || rebuild === undefined || overriddenProvider === undefined) return candidates;
  const rebuilt = await rebuild(overriddenProvider);
  return rebuilt !== undefined && rebuilt.degraded !== true ? rebuilt : candidates;
};

/** Outcome of {@link runSkillsStep}. */
interface SkillsStepResult {
  readonly cancelled: boolean;
  readonly skills?: SkillsCustomizeResult;
}

/**
 * Skills step — once per session, after the row walk(s). `Keep skills (N active)` is the default;
 * only `Customize skills for this run…` opens the checklist, pre-checked to today's effective
 * state, so the submitted set IS the enabled set and `disabled` is its complement. Skipped entirely
 * when there are no candidates (`flows-view.tsx` only supplies them for flows that mount a skill
 * source — `flowMountsSkills` in `launcher.ts`).
 */
const runSkillsStep = async (
  interactive: InteractivePrompt,
  flowTitle: string,
  skillCandidates: SkillCandidatesResult | undefined
): Promise<SkillsStepResult> => {
  if (skillCandidates === undefined || skillCandidates.candidates.length === 0) return { cancelled: false };

  const { candidates, savedDisabled } = skillCandidates;
  const disabledByDefault = new Set(savedDisabled);
  const enabledByDefault = candidates.filter((c) => !disabledByDefault.has(c.name)).map((c) => c.name);

  const entry = await interactive.askChoice<'keep' | 'customize'>('Skills:', [
    { label: `Keep skills (${String(enabledByDefault.length)} active)`, value: 'keep' },
    { label: 'Customize skills for this run…', value: 'customize' },
  ]);
  if (!entry.ok) return { cancelled: true };
  if (entry.value === 'keep') return { cancelled: false };

  const options: ReadonlyArray<Choice<string>> = candidates.map((c) => ({
    label: `${c.name} (${ORIGIN_LABEL[c.origin]})`,
    value: c.name,
    description: c.description,
  }));
  const enabledAns = await interactive.askMultiChoice<string>(
    'Skills for this run — uncheck any to disable:',
    options,
    {
      initial: enabledByDefault,
    }
  );
  if (!enabledAns.ok) return { cancelled: true };
  const enabledNames = new Set(enabledAns.value);
  const disabled = candidates.filter((c) => !enabledNames.has(c.name)).map((c) => c.name);

  const saveAns = await interactive.askChoice<'run-only' | 'remember'>('Remember this choice?', [
    { label: 'Apply for this run only', value: 'run-only' },
    {
      label: `Apply and remember for ${flowTitle}`,
      value: 'remember',
      description: 'Remembers bundled defaults only — other unchecks apply to this run',
    },
  ]);
  if (!saveAns.ok) return { cancelled: true };

  return { cancelled: false, skills: { disabled, saveAsDefault: saveAns.value === 'remember' } };
};

/** Attach the skills outcome to a non-cancel result when there is one. */
const withSkills = (
  result: Exclude<CustomizePickerResult, { readonly kind: 'cancel' }>,
  skills: SkillsCustomizeResult | undefined
): CustomizePickerResult => (skills !== undefined ? { ...result, skills } : result);

/**
 * Implement: generator, then evaluator, then the skills step. Cancel anywhere (mid-evaluator or
 * mid-skills included) discards everything collected — a half-completed session is never applied.
 */
const runImplementCustomize = async (
  ctx: PickerContext,
  flowTitle: string,
  settings: Settings,
  skillsInput: SkillsStepInput
): Promise<CustomizePickerResult> => {
  const roles: readonly AiImplementRole[] = ['generator', 'evaluator'];
  const collected: { generator?: RowOverride; evaluator?: RowOverride } = {};
  for (const role of roles) {
    const result = await customizeRow(
      { ...ctx, header: `${ctx.header}\n\nRole: ${role}` },
      settings.ai.implement[role]
    );
    if (result === undefined) return { kind: 'cancel' };
    if (Object.keys(result).length > 0) collected[role] = result;
  }

  // Skills install under the GENERATOR's provider, so a generator override re-lists the candidates.
  const candidates = await effectiveSkillCandidates(skillsInput, collected.generator?.provider);
  const skillsStep = await runSkillsStep(ctx.interactive, flowTitle, candidates);
  if (skillsStep.cancelled) return { kind: 'cancel' };

  if (collected.generator === undefined && collected.evaluator === undefined) {
    return withSkills({ kind: 'defaults' }, skillsStep.skills);
  }
  return withSkills({ kind: 'implement', implementRoleOverrides: collected }, skillsStep.skills);
};

/** Every non-implement flow: one row walk, then the skills step. */
const runSingleRowCustomize = async (
  ctx: PickerContext,
  flowId: string,
  flowTitle: string,
  settings: Settings,
  skillsInput: SkillsStepInput
): Promise<CustomizePickerResult> => {
  const defaultRow = defaultRowFor(flowId, settings);
  if (defaultRow === undefined) return { kind: 'defaults' };
  const override = await customizeRow(ctx, defaultRow);
  if (override === undefined) return { kind: 'cancel' };

  const candidates = await effectiveSkillCandidates(skillsInput, override.provider);
  const skillsStep = await runSkillsStep(ctx.interactive, flowTitle, candidates);
  if (skillsStep.cancelled) return { kind: 'cancel' };

  return withSkills(
    Object.keys(override).length === 0 ? { kind: 'defaults' } : { kind: 'single', override },
    skillsStep.skills
  );
};

/**
 * Drive the pre-launch picker for one click of an AI-driven flow row. Only called when
 * {@link aiFlowIdForPicker} resolves (non-AI flows never reach it).
 */
export const runCustomizePicker = async ({
  interactive,
  flowId,
  flowTitle,
  settings,
  availableModelsFor,
  skillCandidates,
  rebuildSkillCandidates,
}: RunCustomizePickerArgs): Promise<CustomizePickerResult> => {
  const aiFlow = aiFlowIdForPicker(flowId);
  if (aiFlow === undefined) return { kind: 'defaults' };

  const header = buildPickerHeader(flowId, flowTitle, settings, aiFlow);

  const action = await interactive.askChoice<'start' | 'customize' | 'cancel'>(
    `${header}\n\nWhat would you like to do?`,
    [
      { label: 'Start (use defaults)', value: 'start' },
      { label: 'Customize for this run…', value: 'customize' },
      { label: 'Cancel', value: 'cancel' },
    ]
  );
  if (!action.ok || action.value === 'cancel') return { kind: 'cancel' };
  if (action.value === 'start') return { kind: 'defaults' };

  const ctx: PickerContext = {
    interactive,
    header,
    globalEffort: settings.ai.effort,
    flow: aiFlow,
    availableModelsFor,
  };
  const skillsInput: SkillsStepInput = {
    ...(skillCandidates !== undefined ? { candidates: skillCandidates } : {}),
    ...(rebuildSkillCandidates !== undefined ? { rebuild: rebuildSkillCandidates } : {}),
  };
  return flowId === 'implement'
    ? runImplementCustomize(ctx, flowTitle, settings, skillsInput)
    : runSingleRowCustomize(ctx, flowId, flowTitle, settings, skillsInput);
};
