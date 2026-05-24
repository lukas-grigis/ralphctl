import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { AiFlowSettings, AiImplementRole, AiProvider, AiSettings, Settings } from '@src/domain/entity/settings.ts';
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
 *
 * `ai.implement.{provider,model,effort}` (the legacy flat-row grammar) is rejected: the row
 * now splits into generator / evaluator sub-rows, so callers must address either role
 * explicitly via `ai.implement.generator.<field>` or `ai.implement.evaluator.<field>`.
 */
const SETTINGS_KEY_HINT =
  'supported keys: ai.effort, ai.{flow}.{provider,model,effort} (flow in {refine,plan,readiness,ideate}), ai.implement.{generator,evaluator}.{provider,model,effort}, harness.{maxTurns,maxAttempts,rateLimitRetries,plateauThreshold}, logging.level, concurrency.maxParallelTasks, ui.notifications.enabled';

const IMPLEMENT_ROLES: readonly AiImplementRole[] = ['generator', 'evaluator'];
const isImplementRole = (raw: string): raw is AiImplementRole => (IMPLEMENT_ROLES as readonly string[]).includes(raw);

const AI_PROVIDERS: readonly AiProvider[] = ['claude-code', 'github-copilot', 'openai-codex'];
const isAiProvider = (raw: string): raw is AiProvider => (AI_PROVIDERS as readonly string[]).includes(raw);

const isFlowId = (raw: string): raw is FlowId => (FLOW_IDS as readonly string[]).includes(raw);

const updateFlowRow = (
  row: AiFlowSettings,
  fieldKey: string,
  field: 'provider' | 'model' | 'effort',
  raw: string
): Result<AiFlowSettings, ValidationError> => {
  if (field === 'provider') {
    if (!isAiProvider(raw)) {
      return Result.error(
        new ValidationError({
          field: fieldKey,
          value: raw,
          message: `'${raw}' is not a recognised provider`,
          hint: `expected one of: ${AI_PROVIDERS.join(', ')}`,
        })
      );
    }
    // Changing provider alone would leave `model` pointing at the prior provider's catalog —
    // schema validation rejects that at save time. The dedicated `settings-set-provider` flow
    // handles a coordinated provider+model reset; this single-key surface stays strict.
    return Result.ok({ ...row, provider: raw } as AiFlowSettings);
  }
  if (field === 'model') {
    return Result.ok({ ...row, model: raw } as AiFlowSettings);
  }
  // effort: trim + store; persistence schema validates the value against the provider's
  // native effort enum (`ClaudeEffortSchema`, `CopilotEffortSchema`, `CodexEffortSchema`).
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // Empty input clears the per-flow effort (falls back to global / CLI default).
    const { effort: _drop, ...rowWithoutEffort } = row;
    void _drop;
    return Result.ok(rowWithoutEffort as AiFlowSettings);
  }
  return Result.ok({ ...row, effort: trimmed } as AiFlowSettings);
};

const setAiFlowField = (
  current: Settings,
  flow: Exclude<FlowId, 'implement'>,
  field: 'provider' | 'model' | 'effort',
  raw: string
): Result<Settings, ValidationError> => {
  const updated = updateFlowRow(current.ai[flow], `ai.${flow}.${field}`, field, raw);
  if (!updated.ok) return Result.error(updated.error);
  const nextAi: AiSettings = { ...current.ai, [flow]: updated.value } as AiSettings;
  return Result.ok({ ...current, ai: nextAi });
};

const setAiImplementRoleField = (
  current: Settings,
  role: AiImplementRole,
  field: 'provider' | 'model' | 'effort',
  raw: string
): Result<Settings, ValidationError> => {
  const updated = updateFlowRow(current.ai.implement[role], `ai.implement.${role}.${field}`, field, raw);
  if (!updated.ok) return Result.error(updated.error);
  const nextImplement = { ...current.ai.implement, [role]: updated.value };
  const nextAi: AiSettings = { ...current.ai, implement: nextImplement } as AiSettings;
  return Result.ok({ ...current, ai: nextAi });
};

export const applySettingsKey = (current: Settings, key: string, raw: string): Result<Settings, ValidationError> => {
  // Per-flow AI keys: ai.<flow>.{provider,model,effort} — implement is split into roles and
  // rejects the flat shape; every other flow accepts the 3-part path.
  if (key.startsWith('ai.')) {
    const parts = key.split('.');
    if (parts.length === 3 && parts[0] === 'ai') {
      const maybeFlow = parts[1] ?? '';
      const maybeField = parts[2] ?? '';
      if (
        isFlowId(maybeFlow) &&
        maybeFlow !== 'implement' &&
        (maybeField === 'provider' || maybeField === 'model' || maybeField === 'effort')
      ) {
        return setAiFlowField(current, maybeFlow, maybeField, raw);
      }
      // Flat `ai.implement.<field>` is no longer addressable — the row split into
      // generator / evaluator. Surface a focused error that names the correct keys.
      if (
        maybeFlow === 'implement' &&
        (maybeField === 'provider' || maybeField === 'model' || maybeField === 'effort')
      ) {
        return Result.error(
          new ValidationError({
            field: key,
            value: raw,
            message: `'${key}' is no longer addressable — implement splits into generator and evaluator roles`,
            hint: `use ai.implement.generator.${maybeField} or ai.implement.evaluator.${maybeField}`,
          })
        );
      }
    }
    // Per-role implement keys: ai.implement.{generator,evaluator}.{provider,model,effort}
    if (parts.length === 4 && parts[0] === 'ai' && parts[1] === 'implement') {
      const maybeRole = parts[2] ?? '';
      const maybeField = parts[3] ?? '';
      if (
        isImplementRole(maybeRole) &&
        (maybeField === 'provider' || maybeField === 'model' || maybeField === 'effort')
      ) {
        return setAiImplementRoleField(current, maybeRole, maybeField, raw);
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
