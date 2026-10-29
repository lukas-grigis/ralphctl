import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type {
  AiAgentBindings,
  AiFlowSettings,
  AiImplementRole,
  AiSettings,
  Settings,
} from '@src/domain/entity/settings.ts';
import { AI_PROVIDERS, isAiProvider, remapRetiredModel } from '@src/domain/entity/settings.ts';
import { FLOW_IDS, type FlowId } from '@src/domain/value/flow-id.ts';
import { PROVIDER_EFFORT_LEVELS } from '@src/domain/value/settings-models/effort.ts';

/**
 * Apply one dotted-path change to {@link Settings} — the single key vocabulary behind both the
 * CLI's `settings set` and the TUI's inline editor. Range / enum / coherence checks happen in
 * `SettingsSchema` at save; this fails loud on shape errors and on row values the schema's
 * load-time migration would silently rewrite instead of reject (a retired model, an effort outside
 * the provider's vocabulary). Provider switches go through `settings-set-provider`, which rebuilds
 * the model coherently.
 */
const HARNESS_NUMBER_KEYS = [
  'maxTurns',
  'maxAttempts',
  'rateLimitRetries',
  'idleWatchdogMs',
  'plateauThreshold',
  'correctiveRetries',
  'bestOfNCandidates',
] as const;
const HARNESS_BOOLEAN_KEYS = ['escalateOnPlateau', 'skipPreVerifyOnFreshSetup'] as const;

const isOneOf = <T extends string>(list: readonly T[], raw: string): raw is T =>
  (list as readonly string[]).includes(raw);

const SETTINGS_KEY_HINT = `supported keys: ai.effort, ai.{flow}.{provider,model,effort} (flow in {${FLOW_IDS.filter((f) => f !== 'implement').join(',')}}), ai.implement.{generator,evaluator}.{provider,model,effort}, ai.implement.agents.{generator,evaluator}, harness.{${[...HARNESS_NUMBER_KEYS, ...HARNESS_BOOLEAN_KEYS].join(',')}}, harness.escalationMap.<fromModel>, logging.level, concurrency.maxParallelTasks, ui.notifications.enabled`;

/** Hint attached to a rejected `ai.<flow>.agents.<role>` key targeting an unsupported binding. */
const AGENT_BINDING_UNSUPPORTED_HINT =
  'agent-definition binding is supported only for ai.implement.agents.{generator,evaluator} in this release';

const BOOLEAN_VALUE_HINT = "use 'true' or 'false'";

const IMPLEMENT_ROLES: readonly AiImplementRole[] = ['generator', 'evaluator'];
const isImplementRole = (raw: string): raw is AiImplementRole => (IMPLEMENT_ROLES as readonly string[]).includes(raw);

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
    // Save would silently remap a retired id, so refuse it here and name the successor instead.
    const successor = remapRetiredModel(row.provider, raw);
    if (successor !== raw) {
      return Result.error(
        new ValidationError({
          field: fieldKey,
          value: raw,
          message: `'${raw}' is retired on ${row.provider}`,
          hint: `use '${successor}'`,
        })
      );
    }
    return Result.ok({ ...row, model: raw } as AiFlowSettings);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // Empty input clears the per-flow effort (falls back to global effort, then the flow's shipped default).
    const { effort: _drop, ...rowWithoutEffort } = row;
    void _drop;
    return Result.ok(rowWithoutEffort as AiFlowSettings);
  }
  // Checked here, not left to the schema: save's load-time migration would rewrite a retired level to `low`.
  const levels: readonly string[] = PROVIDER_EFFORT_LEVELS[row.provider];
  if (!levels.includes(trimmed)) {
    return Result.error(
      new ValidationError({
        field: fieldKey,
        value: trimmed,
        message: `'${trimmed}' is not a valid effort for ${row.provider}`,
        hint: `expected one of: ${levels.join(', ')}`,
      })
    );
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

/** Flat `ai.implement.<field>` predates the generator / evaluator split; name the keys that replaced it. */
const rejectFlatImplementKey = (key: string, raw: string, field: string): Result<Settings, ValidationError> =>
  Result.error(
    new ValidationError({
      field: key,
      value: raw,
      message: `'${key}' is no longer addressable — implement splits into generator and evaluator roles`,
      hint: `use ai.implement.generator.${field} or ai.implement.evaluator.${field}`,
    })
  );

/**
 * `ai.implement.agents.<role>` binds (or, empty, clears) an agent definition. Any other
 * `ai.<flow>.agents.<key>` is reported explicitly so a binding is never silently ignored.
 */
const applyAgentsKey = (
  current: Settings,
  key: string,
  raw: string,
  flow: string,
  role: string
): Result<Settings, ValidationError> => {
  if (flow !== 'implement' || !isImplementRole(role)) {
    return Result.error(
      new ValidationError({
        field: key,
        value: raw,
        message: `'${key}' targets a role/flow not supported for agent-definition binding in this release`,
        hint: AGENT_BINDING_UNSUPPORTED_HINT,
      })
    );
  }
  const trimmed = raw.trim();
  const rest: Partial<Record<string, string>> = { ...current.ai.implement.agents };
  if (trimmed.length === 0) {
    delete rest[role];
  } else {
    rest[role] = trimmed;
  }
  const nextAgents = Object.keys(rest).length > 0 ? (rest as AiAgentBindings) : undefined;
  return Result.ok({
    ...current,
    ai: { ...current.ai, implement: { ...current.ai.implement, agents: nextAgents } },
  });
};

/** `ai.effort` — global fallback effort; empty input clears it. */
const applyAiEffortKey = (current: Settings, raw: string): Result<Settings, ValidationError> => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    const { effort: _drop, ...aiWithoutEffort } = current.ai;
    void _drop;
    return Result.ok({ ...current, ai: aiWithoutEffort as AiSettings });
  }
  return Result.ok({ ...current, ai: { ...current.ai, effort: trimmed } as AiSettings });
};

/** Every `ai.*` shape; `undefined` falls through to the unknown-key error. */
const applyAiKey = (current: Settings, key: string, raw: string): Result<Settings, ValidationError> | undefined => {
  if (key === 'ai.effort') return applyAiEffortKey(current, raw);
  const parts = key.split('.');
  const [, flow = '', a = '', b = ''] = parts;
  if (parts.length === 3 && isAiFlowField(a)) {
    if (flow === 'implement') return rejectFlatImplementKey(key, raw, a);
    if (isFlowId(flow) && flow !== 'implement') return setAiFlowField(current, flow, a, raw);
  }
  if (parts.length === 4) {
    if (flow === 'implement' && isImplementRole(a) && isAiFlowField(b)) {
      return setAiImplementRoleField(current, a, b, raw);
    }
    if (a === 'agents') return applyAgentsKey(current, key, raw, flow, b);
  }
  return undefined;
};

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

/** Shared shape for every numeric settings key — same parse-and-error, different field. */
const applyNumberField = (
  current: Settings,
  key: string,
  raw: string,
  apply: (current: Settings, n: number) => Settings
): Result<Settings, ValidationError> => {
  // `Number('')` is 0, so a cleared field would silently store zero.
  if (raw.trim().length === 0) {
    return Result.error(new ValidationError({ field: key, value: raw, message: `'${key}' needs a number` }));
  }
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
  const harnessField = key.startsWith('harness.') ? key.slice('harness.'.length) : '';
  if (isOneOf(HARNESS_NUMBER_KEYS, harnessField)) {
    return applyNumberField(current, key, raw, (c, n) => ({ ...c, harness: { ...c.harness, [harnessField]: n } }));
  }
  if (isOneOf(HARNESS_BOOLEAN_KEYS, harnessField)) {
    return applyBooleanField(current, key, raw, (c, b) => ({ ...c, harness: { ...c.harness, [harnessField]: b } }));
  }
  switch (key) {
    case 'logging.level':
      return Result.ok({ ...current, logging: { level: raw as Settings['logging']['level'] } });
    case 'concurrency.maxParallelTasks':
      return applyNumberField(current, key, raw, (c, n) => ({ ...c, concurrency: { maxParallelTasks: n } }));
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
