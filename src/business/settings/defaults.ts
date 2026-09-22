import {
  type AiProvider,
  type AiSettings,
  CURRENT_SCHEMA_VERSION,
  type Settings,
} from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import {
  COPILOT_LUNA,
  COPILOT_OPUS,
  COPILOT_SONNET,
  GPT_6_LUNA,
  GPT_6_SOL,
  GROK_CHEAP,
  GROK_FLAGSHIP,
  GROK_MID,
  OPENCODE_BIG,
  OPENCODE_MINI,
  OPUS,
  SONNET,
} from '@src/business/settings/preset-model-ids.ts';

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
    refine: SONNET,
    plan: OPUS,
    implement: OPUS,
    readiness: SONNET,
    ideate: OPUS,
    // PR-content drafting is a single-shot summarisation task — Sonnet matches refine's
    // light reasoning profile and avoids the Opus premium for a few-paragraph diff write-up.
    createPr: SONNET,
  },
  // Same tiers as `copilot-only`. Opus 4.8 rather than Opus 5 / 5.5 (plan-gated on Copilot), and
  // it tops the Copilot escalation ladder, so the reset-to-copilot implement default and the
  // ladder top stay aligned.
  'github-copilot': {
    refine: COPILOT_SONNET,
    plan: COPILOT_OPUS,
    implement: COPILOT_OPUS,
    readiness: COPILOT_LUNA,
    ideate: COPILOT_OPUS,
    createPr: COPILOT_LUNA,
  },
  'openai-codex': {
    refine: GPT_6_LUNA,
    plan: GPT_6_SOL,
    // `gpt-6-sol` is the codex flagship; it tops the Codex escalation ladder, so the
    // reset-to-codex implement default and the ladder top stay aligned.
    implement: GPT_6_SOL,
    readiness: GPT_6_LUNA,
    ideate: GPT_6_SOL,
    createPr: GPT_6_LUNA,
  },
  // OpenCode aggregates upstream providers, so there is no vendor flagship to default to. These
  // are the zero-auth free-tier picks — they make a fresh install runnable with no credentials
  // at all, which none of the other four backends offer. An operator who authenticates a real
  // provider via `opencode providers` will want to re-point these at that provider's models;
  // the picker surfaces whatever `opencode models` reports.
  opencode: {
    refine: OPENCODE_MINI,
    plan: OPENCODE_BIG,
    implement: OPENCODE_BIG,
    readiness: OPENCODE_MINI,
    ideate: OPENCODE_BIG,
    createPr: OPENCODE_MINI,
  },
  // Same split as `grok-only`.
  'xai-grok': {
    refine: GROK_MID,
    plan: GROK_FLAGSHIP,
    implement: GROK_FLAGSHIP,
    readiness: GROK_CHEAP,
    ideate: GROK_FLAGSHIP,
    createPr: GROK_CHEAP,
  },
};

/**
 * Build a fully-stamped {@link AiSettings} where every per-flow row uses the supplied
 * provider with that provider's best default model. The global `ai.effort` and every per-flow
 * `effort` are left unset — `resolveEffort` then lands on the flow's shipped default
 * (`FLOW_DEFAULT_EFFORT`), so a fresh record still stamps an explicit level on every spawn
 * rather than inheriting the AI CLI's built-in default (opencode rows excepted).
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
    createPr: { provider, model: models.createPr },
  } as AiSettings;
};

/**
 * Defaults applied when no settings file exists. Conservative across the board — small turn /
 * attempt budgets, serial execution, info-level logging. Users opt into more aggressive
 * settings via the TUI settings panel or `ralphctl settings set <key> <value>`.
 *
 * The implement row deliberately splits roles across providers: Claude Opus drives the
 * generator (deep coder reasoning) while Codex GPT-6 Sol drives the evaluator (independent
 * second opinion). Effort is left unset on both roles per the fresh-default policy above — the
 * implement flow default applies to each; raise `ai.effort` or the row's effort to deepen the gate.
 * Single-provider users override via a preset.
 */
export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  ai: {
    ...defaultAiSettingsForProvider('claude-code'),
    implement: {
      generator: { provider: 'claude-code', model: OPUS },
      evaluator: { provider: 'openai-codex', model: GPT_6_SOL },
    },
  },
  harness: {
    maxTurns: 5,
    maxAttempts: 3,
    rateLimitRetries: 3,
    idleWatchdogMs: 300_000,
    plateauThreshold: 3,
    correctiveRetries: 2,
    escalateOnPlateau: true,
    escalationMap: {},
    skipPreVerifyOnFreshSetup: false,
    // Off by default — the in-loop action-entropy detector is a proxy for a proxy, and the
    // count-based `plateauThreshold` predicate already covers every window it can fire on.
    entropyPlateauDetector: false,
    // On by default at the minimum useful N — a stuck task gets a real second remedy (sample two
    // candidates, select by verification then judging) before settling done-with-warning. The cost
    // is bounded: the rung fires at most ONCE per task, only after the model ladder and the
    // same-model nudge are both spent, and that one attempt spawns 2 generator sessions instead of
    // 1. Cost-sensitive setups opt out — the `*-economic` presets pin this to `0`, and `settings
    // set harness.bestOfNCandidates 0` disables it everywhere.
    bestOfNCandidates: 2,
  },
  logging: { level: 'info' },
  concurrency: { maxParallelTasks: 1 },
  scm: { postRefinementComment: false },
  ui: { notifications: { enabled: true } },
};
