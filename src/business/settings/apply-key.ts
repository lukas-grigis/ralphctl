import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { AiFlowSettings, AiProvider, AiSettings, Settings } from '@src/domain/entity/settings.ts';
import { FLOW_IDS, type FlowId } from '@src/domain/value/flow-id.ts';

/**
 * Apply a single dotted-path change to a {@link Settings} record. Pure — does not touch
 * persistence. Both the CLI's `settings set <key> <value>` and the TUI's inline editor route
 * through this function so the supported key vocabulary is one truth.
 *
 * Final domain validation (numeric ranges, enum membership, provider/model coherence) happens
 * at the persistence boundary via `SettingsSchema`, so this only fails loud on shape errors:
 * unknown keys, non-numeric values where a number was required.
 *
 * Note: `ai.provider` and `ai.models.<flow>` (the v1 grammar) are rejected as unknown keys
 * here — switching a flow's provider goes through the dedicated `settings-set-provider` flow
 * (which rebuilds the row's model coherently); switching one model goes through
 * `ai.<flow>.model`.
 */
const SETTINGS_KEY_HINT =
  'supported keys: ai.effort, ai.{flow}.provider, ai.{flow}.model, ai.{flow}.effort (flow in {refine,plan,implement,readiness,ideate}), harness.{maxTurns,maxAttempts,rateLimitRetries,plateauThreshold}, logging.level, concurrency.maxParallelTasks, ui.notifications.enabled';

const AI_PROVIDERS: readonly AiProvider[] = ['claude-code', 'github-copilot', 'openai-codex'];
const isAiProvider = (raw: string): raw is AiProvider => (AI_PROVIDERS as readonly string[]).includes(raw);

const isFlowId = (raw: string): raw is FlowId => (FLOW_IDS as readonly string[]).includes(raw);

const setAiFlowField = (
  current: Settings,
  flow: FlowId,
  field: 'provider' | 'model' | 'effort',
  raw: string
): Result<Settings, ValidationError> => {
  const row = current.ai[flow];
  let nextRow: AiFlowSettings;
  if (field === 'provider') {
    if (!isAiProvider(raw)) {
      return Result.error(
        new ValidationError({
          field: `ai.${flow}.provider`,
          value: raw,
          message: `'${raw}' is not a recognised provider`,
          hint: `expected one of: ${AI_PROVIDERS.join(', ')}`,
        })
      );
    }
    // Changing provider alone would leave `model` pointing at the prior provider's catalog —
    // schema validation rejects that at save time. The dedicated `settings-set-provider` flow
    // handles a coordinated provider+model reset; this single-key surface stays strict.
    nextRow = { ...row, provider: raw } as AiFlowSettings;
  } else if (field === 'model') {
    nextRow = { ...row, model: raw } as AiFlowSettings;
  } else {
    // effort: trim + store; persistence schema validates the value against the provider's
    // native effort enum (`ClaudeEffortSchema`, `CopilotEffortSchema`, `CodexEffortSchema`).
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      // Empty input clears the per-flow effort (falls back to global / CLI default).
      const { effort: _drop, ...rowWithoutEffort } = row;
      void _drop;
      nextRow = rowWithoutEffort as AiFlowSettings;
    } else {
      nextRow = { ...row, effort: trimmed } as AiFlowSettings;
    }
  }
  const nextAi: AiSettings = { ...current.ai, [flow]: nextRow } as AiSettings;
  return Result.ok({ ...current, ai: nextAi });
};

export const applySettingsKey = (current: Settings, key: string, raw: string): Result<Settings, ValidationError> => {
  // Per-flow AI keys: ai.<flow>.{provider,model,effort}
  if (key.startsWith('ai.')) {
    const parts = key.split('.');
    if (parts.length === 3 && parts[0] === 'ai') {
      const maybeFlow = parts[1] ?? '';
      const maybeField = parts[2] ?? '';
      if (isFlowId(maybeFlow) && (maybeField === 'provider' || maybeField === 'model' || maybeField === 'effort')) {
        return setAiFlowField(current, maybeFlow, maybeField, raw);
      }
    }
    if (key === 'ai.effort') {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        const { effort: _drop, ...aiWithoutEffort } = current.ai;
        void _drop;
        return Result.ok({ ...current, ai: aiWithoutEffort as AiSettings });
      }
      return Result.ok({ ...current, ai: { ...current.ai, effort: trimmed } as AiSettings });
    }
  }
  switch (key) {
    case 'harness.maxTurns':
    case 'harness.maxAttempts':
    case 'harness.rateLimitRetries':
    case 'harness.plateauThreshold': {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return Result.error(new ValidationError({ field: key, value: raw, message: `'${raw}' is not a number` }));
      }
      const which = key.split('.')[1] as keyof Settings['harness'];
      return Result.ok({ ...current, harness: { ...current.harness, [which]: n } });
    }
    case 'logging.level': {
      return Result.ok({ ...current, logging: { level: raw as Settings['logging']['level'] } });
    }
    case 'concurrency.maxParallelTasks': {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return Result.error(new ValidationError({ field: key, value: raw, message: `'${raw}' is not a number` }));
      }
      return Result.ok({ ...current, concurrency: { maxParallelTasks: n } });
    }
    case 'ui.notifications.enabled': {
      const b = parseBool(raw);
      if (b === undefined) {
        return Result.error(
          new ValidationError({
            field: key,
            value: raw,
            message: `'${raw}' is not a boolean`,
            hint: "use 'true' or 'false'",
          })
        );
      }
      return Result.ok({
        ...current,
        ui: { ...current.ui, notifications: { ...current.ui.notifications, enabled: b } },
      });
    }
    default:
      return Result.error(
        new ValidationError({
          field: 'key',
          value: key,
          message: `unknown settings key '${key}'`,
          hint: SETTINGS_KEY_HINT,
        })
      );
  }
};

/**
 * Parse a boolean from the CLI's `key=value` syntax. Accepts the common synonyms so users can
 * type whichever shorthand feels natural. Returns `undefined` for unrecognised values.
 */
const parseBool = (raw: string): boolean | undefined => {
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return true;
  if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false;
  return undefined;
};

/**
 * Parse `key=value` syntax used by both the CLI's positional args and the TUI's inline-edit
 * prompt. Trims whitespace around both sides. Returns `undefined` for malformed input so the
 * caller can surface a focused error.
 */
export const parseSettingsKvSyntax = (raw: string): { readonly key: string; readonly value: string } | undefined => {
  const eq = raw.indexOf('=');
  if (eq < 0) return undefined;
  const key = raw.slice(0, eq).trim();
  const value = raw.slice(eq + 1).trim();
  if (key.length === 0) return undefined;
  return { key, value };
};
