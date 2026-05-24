import {
  CURRENT_SCHEMA_VERSION,
  type AiProvider,
  type AiSettings,
  type Settings,
} from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';

/**
 * Per-provider, per-flow default model picks. Used by the welcome flow when the user picks a
 * provider on first run, by `settings-set-provider` when the user re-aligns one flow's
 * provider, and by tests that need a known-good fully-stamped `AiSettings`.
 *
 * The chosen models lean toward "best general-purpose" within each provider's catalog. Power
 * users can refine via `ralphctl settings set ai.<flow>.model <id>` or the TUI editor.
 */
const DEFAULT_MODELS_BY_PROVIDER: Readonly<Record<AiProvider, Readonly<Record<FlowId, string>>>> = {
  'claude-code': {
    refine: 'claude-sonnet-4-6',
    plan: 'claude-opus-4-7',
    implement: 'claude-opus-4-7',
    readiness: 'claude-sonnet-4-6',
    ideate: 'claude-opus-4-7',
  },
  'github-copilot': {
    refine: 'gpt-5-mini',
    plan: 'gpt-5.4',
    implement: 'gpt-5.4',
    readiness: 'gpt-5-mini',
    ideate: 'gpt-5.4',
  },
  'openai-codex': {
    refine: 'gpt-5.4-mini',
    plan: 'gpt-5.5',
    implement: 'gpt-5.3-codex',
    readiness: 'gpt-5.4-mini',
    ideate: 'gpt-5.5',
  },
};

/**
 * Build a fully-stamped {@link AiSettings} where every per-flow row uses the supplied
 * provider with that provider's best default model. The global `ai.effort` is left unset —
 * `resolveEffort` falls through to the per-flow `effort` (also unset by default), so a fresh
 * record leaves the AI CLI to use its built-in default.
 *
 * `implement` stamps the same provider+model on both `generator` and `evaluator` so the
 * "every flow runs on one provider" preset story stays intact; cross-provider splits are
 * configured explicitly by editing the role keys.
 *
 * This shape is what `settings-set-provider` writes when the user "reset every flow to this
 * provider"; welcome uses it for first-run.
 */
export const defaultAiSettingsForProvider = (provider: AiProvider): AiSettings => {
  const models = DEFAULT_MODELS_BY_PROVIDER[provider];
  const implementRow = { provider, model: models.implement };
  return {
    refine: { provider, model: models.refine },
    plan: { provider, model: models.plan },
    implement: { generator: implementRow, evaluator: implementRow },
    readiness: { provider, model: models.readiness },
    ideate: { provider, model: models.ideate },
  } as AiSettings;
};

/**
 * Defaults applied when no settings file exists. Conservative across the board — small turn /
 * attempt budgets, serial execution, info-level logging. Users opt into more aggressive
 * settings via the TUI settings panel or `ralphctl settings set <key> <value>`.
 *
 * The implement row deliberately splits roles across providers: Claude Opus drives the
 * generator (deep coder reasoning) while Codex GPT-5.5 drives the evaluator (independent
 * second opinion). Single-provider users override via a preset.
 */
export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  ai: {
    ...defaultAiSettingsForProvider('claude-code'),
    implement: {
      generator: { provider: 'claude-code', model: 'claude-opus-4-7' },
      evaluator: { provider: 'openai-codex', model: 'gpt-5.5' },
    },
  },
  harness: { maxTurns: 5, maxAttempts: 3, rateLimitRetries: 3, plateauThreshold: 2 },
  logging: { level: 'info' },
  concurrency: { maxParallelTasks: 1 },
  ui: { notifications: { enabled: true } },
  developer: { showEvaluatorFailureUI: false },
};
