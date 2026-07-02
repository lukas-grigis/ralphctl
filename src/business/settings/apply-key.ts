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
  'supported keys: ai.effort, ai.{flow}.{provider,model,effort} (flow in {refine,plan,readiness,ideate,createPr}), ai.implement.{generator,evaluator}.{provider,model,effort}, harness.{maxTurns,maxAttempts,rateLimitRetries,idleWatchdogMs,plateauThreshold,correctiveRetries,escalateOnPlateau,skipPreVerifyOnFreshSetup}, harness.escalationMap.<fromModel>, logging.level, concurrency.maxParallelTasks, scm.postRefinementComment, ui.notifications.enabled';

const BOOLEAN_VALUE_HINT = "use 'true' or 'false'";

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

const isAiFlowField = (raw: string): raw is 'provider' | 'model' | 'effort' =>
  raw === 'provider' || raw === 'model' || raw === 'effort';

/** `ai.<flow>.<field>` — every flow except `implement`, which splits into roles below. */
const tryApplyAiFlowKey = (
  current: Settings,
  key: string,
  raw: string
): Result<Settings, ValidationError> | undefined => {
  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== 'ai') return undefined;
  const maybeFlow = parts[1] ?? '';
  const maybeField = parts[2] ?? '';
  if (isFlowId(maybeFlow) && maybeFlow !== 'implement' && isAiFlowField(maybeField)) {
    return setAiFlowField(current, maybeFlow, maybeField, raw);
  }
  return undefined;
};

/**
 * Flat `ai.implement.<field>` is no longer addressable — the row split into generator /
 * evaluator. Surface a focused error that names the correct keys.
 */
const tryRejectFlatImplementKey = (key: string, raw: string): Result<Settings, ValidationError> | undefined => {
  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== 'ai') return undefined;
  const maybeFlow = parts[1] ?? '';
  const maybeField = parts[2] ?? '';
  if (maybeFlow !== 'implement' || !isAiFlowField(maybeField)) return undefined;
  return Result.error(
    new ValidationError({
      field: key,
      value: raw,
      message: `'${key}' is no longer addressable — implement splits into generator and evaluator roles`,
      hint: `use ai.implement.generator.${maybeField} or ai.implement.evaluator.${maybeField}`,
    })
  );
};

/** Per-role implement keys: `ai.implement.{generator,evaluator}.{provider,model,effort}`. */
const tryApplyAiImplementRoleKey = (
  current: Settings,
  key: string,
  raw: string
): Result<Settings, ValidationError> | undefined => {
  const parts = key.split('.');
  if (parts.length !== 4 || parts[0] !== 'ai' || parts[1] !== 'implement') return undefined;
  const maybeRole = parts[2] ?? '';
  const maybeField = parts[3] ?? '';
  if (isImplementRole(maybeRole) && isAiFlowField(maybeField)) {
    return setAiImplementRoleField(current, maybeRole, maybeField, raw);
  }
  return undefined;
};

/** `ai.effort` — global fallback effort; empty input clears it. */
const tryApplyAiEffortKey = (
  current: Settings,
  key: string,
  raw: string
): Result<Settings, ValidationError> | undefined => {
  if (key !== 'ai.effort') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    const { effort: _drop, ...aiWithoutEffort } = current.ai;
    void _drop;
    return Result.ok({ ...current, ai: aiWithoutEffort as AiSettings });
  }
  return Result.ok({ ...current, ai: { ...current.ai, effort: trimmed } as AiSettings });
};

/**
 * Dispatch every `ai.*` key shape. Returns `undefined` when `key` starts with `ai.` but
 * matches none of the known sub-grammars, so the caller falls through to the unknown-key error.
 */
const applyAiKey = (current: Settings, key: string, raw: string): Result<Settings, ValidationError> | undefined =>
  tryApplyAiFlowKey(current, key, raw) ??
  tryRejectFlatImplementKey(key, raw) ??
  tryApplyAiImplementRoleKey(current, key, raw) ??
  tryApplyAiEffortKey(current, key, raw);

/**
 * Per-entry escalation-map setter: `harness.escalationMap.<fromModel>` takes the upgraded
 * model id; empty input clears the entry (mirrors per-flow effort clearing).
 */
const applyEscalationMapKey = (current: Settings, key: string, raw: string): Result<Settings, ValidationError> => {
  const fromModel = key.slice('harness.escalationMap.'.length);
  if (fromModel.length === 0) {
    return Result.error(
      new ValidationError({
        field: 'key',
        value: key,
        message: `'${key}' is missing the source model id`,
        hint: 'use harness.escalationMap.<fromModel>',
      })
    );
  }
  const nextMap = { ...current.harness.escalationMap };
  if (raw.trim().length === 0) {
    delete nextMap[fromModel];
  } else {
    nextMap[fromModel] = raw;
  }
  return Result.ok({ ...current, harness: { ...current.harness, escalationMap: nextMap } });
};

/** Shared shape for the four numeric `harness.*` keys — same parse-and-error, different field. */
const applyNumberField = (
  current: Settings,
  key: string,
  raw: string,
  apply: (current: Settings, n: number) => Settings
): Result<Settings, ValidationError> => {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return Result.error(new ValidationError({ field: key, value: raw, message: `'${raw}' is not a number` }));
  }
  return Result.ok(apply(current, n));
};

/** Shared shape for the boolean settings keys — same parse-and-error, different field. */
const applyBooleanField = (
  current: Settings,
  key: string,
  raw: string,
  apply: (current: Settings, b: boolean) => Settings
): Result<Settings, ValidationError> => {
  const b = parseBool(raw);
  if (b === undefined) {
    return Result.error(
      new ValidationError({ field: key, value: raw, message: `'${raw}' is not a boolean`, hint: BOOLEAN_VALUE_HINT })
    );
  }
  return Result.ok(apply(current, b));
};

/** Fixed, non-templated settings keys — everything outside the `ai.*` / escalation-map grammars. */
const applyFixedSettingsKey = (current: Settings, key: string, raw: string): Result<Settings, ValidationError> => {
  switch (key) {
    case 'harness.maxTurns':
    case 'harness.maxAttempts':
    case 'harness.rateLimitRetries':
    case 'harness.idleWatchdogMs':
    case 'harness.plateauThreshold':
    case 'harness.correctiveRetries': {
      const which = key.split('.')[1] as
        | 'maxTurns'
        | 'maxAttempts'
        | 'rateLimitRetries'
        | 'idleWatchdogMs'
        | 'plateauThreshold'
        | 'correctiveRetries';
      return applyNumberField(current, key, raw, (c, n) => ({ ...c, harness: { ...c.harness, [which]: n } }));
    }
    case 'harness.escalateOnPlateau':
      return applyBooleanField(current, key, raw, (c, b) => ({
        ...c,
        harness: { ...c.harness, escalateOnPlateau: b },
      }));
    case 'harness.skipPreVerifyOnFreshSetup':
      return applyBooleanField(current, key, raw, (c, b) => ({
        ...c,
        harness: { ...c.harness, skipPreVerifyOnFreshSetup: b },
      }));
    case 'logging.level':
      return Result.ok({ ...current, logging: { level: raw as Settings['logging']['level'] } });
    case 'concurrency.maxParallelTasks':
      return applyNumberField(current, key, raw, (c, n) => ({ ...c, concurrency: { maxParallelTasks: n } }));
    case 'scm.postRefinementComment':
      return applyBooleanField(current, key, raw, (c, b) => ({
        ...c,
        scm: { ...c.scm, postRefinementComment: b },
      }));
    case 'ui.notifications.enabled':
      return applyBooleanField(current, key, raw, (c, b) => ({
        ...c,
        ui: { ...c.ui, notifications: { ...c.ui.notifications, enabled: b } },
      }));
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

export const applySettingsKey = (current: Settings, key: string, raw: string): Result<Settings, ValidationError> => {
  if (key.startsWith('ai.')) {
    const applied = applyAiKey(current, key, raw);
    if (applied !== undefined) return applied;
  } else if (key.startsWith('harness.escalationMap.')) {
    return applyEscalationMapKey(current, key, raw);
  }
  return applyFixedSettingsKey(current, key, raw);
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
