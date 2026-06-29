/**
 * Pre-launch customize picker used by `flows-view.tsx`. For an AI-driven flow the user gets
 * three choices on the entry prompt — `Start (use defaults)`, `Customize for this run…`, or
 * `Cancel`. Customize walks the user through provider → model → effort, with `Keep default`
 * as the first option on each step; implement walks generator (three steps) then evaluator
 * (three steps). The picker only ever reads {@link Settings}; it never calls `save()`, so
 * the on-disk file is byte-identical before and after any picker session.
 *
 * Extracted from the view into a standalone module so tests can drive it with a scripted
 * {@link InteractivePrompt} fake without mounting Ink. The view's `onSelect` calls
 * {@link runCustomizePicker} and threads the returned {@link CustomizePickerResult} into the
 * launcher's {@link LaunchExtras}.
 */

import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import {
  type AiFlowSettings,
  type AiImplementRole,
  type AiProvider,
  primaryFlowRow,
  type Settings,
} from '@src/domain/entity/settings.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';
import { PROVIDER_EFFORT_LEVELS } from '@src/domain/value/settings-models/effort.ts';
import { isSuspendedModel, SUSPENSION_NOTE } from '@src/domain/value/settings-models/suspended-models.ts';
import { contextWindowLabel } from '@src/domain/value/settings-models/context-window.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { resolveEffortForRow } from '@src/business/settings/resolve-effort.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import type { LaunchExtras } from '@src/application/ui/shared/launcher.ts';

/**
 * Catalog lookup for the customize picker — imported from the same domain modules
 * `settings-view.tsx` reads so the two surfaces can never drift on a model bump.
 */
export const modelCatalogFor = (provider: AiProvider): readonly string[] => {
  switch (provider) {
    case 'claude-code':
      return CLAUDE_MODELS;
    case 'github-copilot':
      return COPILOT_MODELS;
    case 'openai-codex':
      return CODEX_MODELS;
  }
};

const AI_PROVIDERS: readonly AiProvider[] = ['claude-code', 'github-copilot', 'openai-codex'];

/**
 * Resolve the model catalog the picker offers for a provider. Prefers the injected
 * availability lookup (account-narrowed subset) when present; falls back to the full static
 * catalog (the test / no-deps path).
 */
const resolveModelCatalog = async (
  provider: AiProvider,
  availableModelsFor: ((provider: AiProvider) => Promise<readonly string[]>) | undefined
): Promise<readonly string[]> => (availableModelsFor ? availableModelsFor(provider) : modelCatalogFor(provider));

/** Sentinel value returned for the `Keep default` option — never collides with a real id. */
const KEEP = '__keep__';

/**
 * Map a model id to a picker choice. Appends the context-window size and (when applicable) the
 * suspension note to the LABEL only — the `value` stays the bare id so a pre-pinned choice still
 * round-trips; if the user picks a suspended model, the adapter guard rejects it at launch.
 * Applies to both the static and account-narrowed catalogs.
 *
 *   'claude-sonnet-4-6'    →  'claude-sonnet-4-6  ·  200K'
 *   'claude-opus-4-8[1m]' →  'claude-opus-4-8[1m]  ·  1M'
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
 * Outcome of one picker session. `kind` discriminates:
 *   - `cancel`: user pressed Esc / picked Cancel at any step — launcher should NOT launch
 *   - `defaults`: user picked Start — launcher should launch with no override
 *   - `single`: customize completed for a single-row flow; `override` is the per-field diff
 *   - `implement`: customize completed for implement; `implementRoleOverrides` carries both
 *     roles (each independently optional)
 *
 * The picker never returns `single` for implement and never returns `implement` for any
 * other flow.
 */
export type CustomizePickerResult =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'defaults' }
  | { readonly kind: 'single'; readonly override: NonNullable<LaunchExtras['override']> }
  | {
      readonly kind: 'implement';
      readonly implementRoleOverrides: NonNullable<LaunchExtras['implementRoleOverrides']>;
    };

/**
 * Map a TUI flow id to the AI {@link FlowId} that owns its session — same mapping the launcher
 * and check-cli use. Returns `undefined` for non-AI flows; the picker is skipped for those.
 */
const aiFlowIdForPicker = (flowId: string): FlowId | undefined => {
  switch (flowId) {
    case 'refine':
    case 'plan':
    case 'implement':
    case 'readiness':
    case 'ideate':
      return flowId;
    case 'detect-scripts':
    case 'detect-skills':
      return 'readiness';
    case 'review':
      return 'implement';
    default:
      return undefined;
  }
};

/**
 * Resolve the single row the picker should present as the default for a non-implement-launch
 * flow. For review the launcher uses `ai.implement.generator`; the picker shows that row.
 */
const defaultRowFor = (flowId: string, settings: Settings): AiFlowSettings | undefined => {
  const aiFlow = aiFlowIdForPicker(flowId);
  if (aiFlow === undefined) return undefined;
  return primaryFlowRow(settings.ai, aiFlow);
};

const labelKeepDefault = (value: string | undefined): string => `Keep default (${value ?? 'unset'})`;

const formatRow = (row: AiFlowSettings, globalEffort: Settings['ai']['effort']): string => {
  const resolved = resolveEffortForRow(row, globalEffort);
  return `${row.provider} / ${row.model} / ${resolved ?? 'auto'}`;
};

/**
 * Walk one row through the three sequential prompts — provider → model → effort. Returns the
 * per-field override (only fields the user changed) or `undefined` when the user cancels at
 * any step. Empty when the user picked `Keep default` on every step.
 */
const customizeRow = async (
  interactive: InteractivePrompt,
  header: string,
  defaultRow: AiFlowSettings,
  globalEffort: Settings['ai']['effort'],
  availableModelsFor: ((provider: AiProvider) => Promise<readonly string[]>) | undefined
): Promise<NonNullable<LaunchExtras['override']> | undefined> => {
  // Step 1 — provider. Keep default first, then every provider option (including the
  // default's own provider; picking it explicitly is treated as "no change").
  const providerOptions: ReadonlyArray<Choice<string>> = [
    { label: labelKeepDefault(defaultRow.provider), value: KEEP },
    ...AI_PROVIDERS.map((p) => ({ label: p, value: p })),
  ];
  const providerAns = await interactive.askChoice<string>(`${header}\nProvider:`, providerOptions);
  if (!providerAns.ok) return undefined;
  const providerChanged = providerAns.value !== KEEP && providerAns.value !== defaultRow.provider;
  const effectiveProvider: AiProvider = providerChanged ? (providerAns.value as AiProvider) : defaultRow.provider;

  // Step 2 — model. When the provider switched, the saved default model belongs to a
  // different provider's catalog; omit `Keep default` so the user can't accidentally pick an
  // incompatible model. Otherwise show `Keep default` first.
  const modelCatalog = await resolveModelCatalog(effectiveProvider, availableModelsFor);
  const modelOptions: ReadonlyArray<Choice<string>> = providerChanged
    ? modelCatalog.map(modelChoice)
    : [{ label: labelKeepDefault(defaultRow.model), value: KEEP }, ...modelCatalog.map(modelChoice)];
  const modelAns = await interactive.askChoice<string>(`${header}\nModel:`, modelOptions);
  if (!modelAns.ok) return undefined;

  // Step 3 — effort. When the provider switched, the saved row's effort may not exist in the
  // new provider's vocabulary; `Keep default` then means "let the launcher resolve" (the row
  // carries no per-flow effort, so resolveEffort floors the global value to the new provider).
  //
  // When the provider stayed the same but the model changed, the saved row's effort would be
  // silently inherited — which is the bug: sonnet @ xhigh (the worst wall-clock combination)
  // appears when the user's intent was only "use a cheaper model". Make the inheritance
  // visible by labelling the keep-default option with the concrete value it carries, flagging
  // whether it comes from the saved row or the global default so the user can decide
  // deliberately. The model-changed case also shifts the highlighted default to the global
  // effort (or 'auto') rather than the per-row value so the safest option leads.
  const effortCatalog = PROVIDER_EFFORT_LEVELS[effectiveProvider];
  const modelChanged = modelAns.value !== KEEP && modelAns.value !== defaultRow.model;
  const resolvedRowEffort = resolveEffortForRow(defaultRow, globalEffort);
  let effortDefaultLabel: string;
  if (providerChanged) {
    // Provider switched — the saved row's effort vocabulary may not apply; omit the concrete
    // value so the user isn't misled into thinking it will carry over.
    effortDefaultLabel = 'Keep default';
  } else if (modelChanged) {
    // Model changed but provider stayed. Show the value the row would inherit AND flag that
    // it comes from the saved row, so the user can make a deliberate choice.
    const rowEffortSource = defaultRow.effort !== undefined ? 'saved row' : globalEffort !== undefined ? 'global' : '';
    const effortDisplay = resolvedRowEffort ?? 'auto';
    effortDefaultLabel =
      rowEffortSource.length > 0
        ? `Keep default (${effortDisplay} — ${rowEffortSource})`
        : `Keep default (${effortDisplay})`;
  } else {
    // Neither provider nor model changed — show the resolved effort as-is (existing behaviour).
    effortDefaultLabel = labelKeepDefault(resolvedRowEffort ?? 'auto');
  }
  const effortOptions: ReadonlyArray<Choice<string>> = [
    { label: effortDefaultLabel, value: KEEP },
    ...effortCatalog.map((e) => ({ label: e, value: e })),
  ];
  const effortAns = await interactive.askChoice<string>(`${header}\nEffort:`, effortOptions);
  if (!effortAns.ok) return undefined;

  const override: { provider?: AiProvider; model?: string; effort?: string } = {};
  if (providerChanged) override.provider = providerAns.value as AiProvider;
  if (modelAns.value !== KEEP && modelAns.value !== defaultRow.model) override.model = modelAns.value;
  if (effortAns.value !== KEEP) override.effort = effortAns.value;
  // When the provider switched but model / effort were not chosen, we still need a model
  // (the launcher can't merge a model from the old provider's catalog). When provider
  // changed and model was unset above (because it matched defaultRow.model on a single
  // catalog overlap), force the picked value through.
  if (providerChanged && override.model === undefined) override.model = modelAns.value;
  return override;
};

export interface RunCustomizePickerArgs {
  readonly interactive: InteractivePrompt;
  readonly flowId: string;
  readonly flowTitle: string;
  readonly settings: Settings;
  /**
   * Optional per-provider availability lookup (injected from `AppDeps.availableModelsFor`). When
   * present the model step shows only the operator's account-available models; when absent the
   * step falls back to the full {@link modelCatalogFor} catalog (the test / no-deps path).
   */
  readonly availableModelsFor?: (provider: AiProvider) => Promise<readonly string[]>;
}

/**
 * Drive the pre-launch picker for one click of an AI-driven flow row. Returns `kind: 'cancel'`
 * for the cancel path (launcher should not launch); `kind: 'defaults'` when the user picked
 * Start (launcher should launch with no override); `kind: 'single'` / `kind: 'implement'`
 * with the override payload when the user completed Customize.
 *
 * Non-AI flows (create-sprint, ticket-*, etc.) never reach this function — the picker is only
 * called when {@link aiFlowIdForPicker} resolves to a flow id.
 */
export const runCustomizePicker = async ({
  interactive,
  flowId,
  flowTitle,
  settings,
  availableModelsFor,
}: RunCustomizePickerArgs): Promise<CustomizePickerResult> => {
  const aiFlow = aiFlowIdForPicker(flowId);
  if (aiFlow === undefined) return { kind: 'defaults' };

  // Header context — shown at the top of every prompt frame so the user always knows what
  // the current defaults are. For implement we render both gen and eval; for everything else
  // we render the single resolved row.
  const header =
    flowId === 'implement'
      ? `${flowTitle} — current defaults:\n  generator: ${formatRow(settings.ai.implement.generator, settings.ai.effort)}\n  evaluator: ${formatRow(settings.ai.implement.evaluator, settings.ai.effort)}`
      : `${flowTitle} — current default: ${formatRow(defaultRowFor(flowId, settings)!, settings.ai.effort)}`;

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

  if (flowId === 'implement') {
    // Walk generator first, then evaluator. Cancel at any step (including mid-evaluator)
    // closes the picker without launching and discards any generator override already set —
    // the launcher must not apply a half-completed customize session.
    const roles: readonly AiImplementRole[] = ['generator', 'evaluator'];
    const collected: {
      generator?: NonNullable<LaunchExtras['override']>;
      evaluator?: NonNullable<LaunchExtras['override']>;
    } = {};
    for (const role of roles) {
      const row = role === 'generator' ? settings.ai.implement.generator : settings.ai.implement.evaluator;
      const roleHeader = `${header}\n\nRole: ${role}`;
      const result = await customizeRow(interactive, roleHeader, row, settings.ai.effort, availableModelsFor);
      if (result === undefined) return { kind: 'cancel' };
      if (Object.keys(result).length > 0) collected[role] = result;
    }
    if (collected.generator === undefined && collected.evaluator === undefined) {
      // Both roles kept all defaults — same outcome as picking Start.
      return { kind: 'defaults' };
    }
    return {
      kind: 'implement',
      implementRoleOverrides: {
        ...(collected.generator !== undefined ? { generator: collected.generator } : {}),
        ...(collected.evaluator !== undefined ? { evaluator: collected.evaluator } : {}),
      },
    };
  }

  const defaultRow = defaultRowFor(flowId, settings);
  if (defaultRow === undefined) return { kind: 'defaults' };
  const override = await customizeRow(interactive, header, defaultRow, settings.ai.effort, availableModelsFor);
  if (override === undefined) return { kind: 'cancel' };
  if (Object.keys(override).length === 0) return { kind: 'defaults' };
  return { kind: 'single', override };
};
