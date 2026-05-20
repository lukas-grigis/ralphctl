import {
  CURRENT_SCHEMA_VERSION,
  type AiProvider,
  type AiSettings,
  type Settings,
} from '@src/domain/entity/settings.ts';

/**
 * Per-provider AI defaults. The welcome flow plucks the appropriate entry when the user picks
 * a provider on first run; the result is a fully-coherent {@link AiSettings} that satisfies the
 * schema's discriminated union without forcing the user to also pick five model ids.
 *
 * The chosen models lean toward "best general-purpose" within each provider's catalog. Power
 * users can refine via `ralphctl settings set ai.models.<chain> <id>` or the TUI editor.
 */
export const DEFAULT_AI_SETTINGS_BY_PROVIDER: Readonly<Record<AiProvider, AiSettings>> = {
  'claude-code': {
    provider: 'claude-code',
    models: {
      refine: 'claude-sonnet-4-6',
      plan: 'claude-opus-4-7',
      implement: 'claude-opus-4-7',
      readiness: 'claude-sonnet-4-6',
      ideate: 'claude-opus-4-7',
    },
  },
  'github-copilot': {
    provider: 'github-copilot',
    models: {
      refine: 'gpt-5-mini',
      plan: 'gpt-5.4',
      implement: 'gpt-5.4',
      readiness: 'gpt-5-mini',
      ideate: 'gpt-5.4',
    },
  },
  'openai-codex': {
    provider: 'openai-codex',
    models: {
      refine: 'gpt-5.4-mini',
      plan: 'gpt-5.5',
      implement: 'gpt-5.3-codex',
      readiness: 'gpt-5.4-mini',
      ideate: 'gpt-5.5',
    },
  },
};

/**
 * Defaults applied when no settings file exists. Conservative across the board — small turn /
 * attempt budgets, serial execution, info-level logging. Users opt into more aggressive
 * settings via the TUI settings panel or `ralphctl settings set <key> <value>`.
 */
export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  ai: DEFAULT_AI_SETTINGS_BY_PROVIDER['claude-code'],
  harness: { maxTurns: 5, maxAttempts: 3, rateLimitRetries: 3, plateauThreshold: 2 },
  logging: { level: 'info' },
  concurrency: { maxParallelTasks: 1 },
  ui: { notifications: { enabled: true } },
};
