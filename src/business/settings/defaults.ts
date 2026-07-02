import {
  type AiProvider,
  type AiSettings,
  CURRENT_SCHEMA_VERSION,
  type Settings,
} from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';

// Model identifiers referenced more than once below, hoisted to named constants so each literal
// appears once. The dash spelling (`claude-sonnet-5`, `claude-opus-4-8`) is the claude-code
// catalog form. Sonnet 5 is the default Sonnet for Claude Code.
const CLAUDE_SONNET = 'claude-sonnet-5';
const CLAUDE_OPUS = 'claude-opus-4-8';
const GPT_5_MINI = 'gpt-5-mini';
const GPT_5_4_MINI = 'gpt-5.4-mini';

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
    refine: CLAUDE_SONNET,
    plan: CLAUDE_OPUS,
    implement: CLAUDE_OPUS,
    readiness: CLAUDE_SONNET,
    ideate: CLAUDE_OPUS,
    // PR-content drafting is a single-shot summarisation task — Sonnet matches refine's
    // light reasoning profile and avoids the Opus premium for a few-paragraph diff write-up.
    createPr: CLAUDE_SONNET,
  },
  'github-copilot': {
    refine: GPT_5_MINI,
    plan: 'gpt-5.4',
    implement: 'gpt-5.4',
    readiness: GPT_5_MINI,
    ideate: 'gpt-5.4',
    createPr: GPT_5_MINI,
  },
  'openai-codex': {
    refine: GPT_5_4_MINI,
    plan: 'gpt-5.5',
    // `gpt-5.3-codex` is deprecated for ChatGPT sign-in — the "reset implement to Codex" path
    // rides the frontier default `gpt-5.5` instead, matching the CODEX_ONLY preset decision so
    // the everyday autonomous loop works under ChatGPT auth and sits at the top of the ladder.
    implement: 'gpt-5.5',
    readiness: GPT_5_4_MINI,
    ideate: 'gpt-5.5',
    createPr: GPT_5_4_MINI,
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
    createPr: { provider, model: models.createPr },
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
      generator: { provider: 'claude-code', model: CLAUDE_OPUS },
      evaluator: { provider: 'openai-codex', model: 'gpt-5.5' },
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
  },
  logging: { level: 'info' },
  concurrency: { maxParallelTasks: 1 },
  scm: { postRefinementComment: false },
  ui: { notifications: { enabled: true } },
  developer: { showEvaluatorFailureUI: false },
};
