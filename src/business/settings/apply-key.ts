import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Settings } from '@src/domain/entity/settings.ts';

/**
 * Apply a single dotted-path change to a {@link Settings} record. Pure — does not touch
 * persistence. Both the CLI's `settings set <key> <value>` and the TUI's inline editor route
 * through this function so the supported key vocabulary is one truth.
 *
 * Final domain validation (numeric ranges, enum membership, provider/model coherence) happens
 * at the persistence boundary via `SettingsSchema`, so this only fails loud on shape errors:
 * unknown keys, non-numeric values where a number was required, or invariants that can't be
 * salvaged at the schema layer (changing `ai.provider` alone leaves models incoherent).
 */
export const applySettingsKey = (current: Settings, key: string, raw: string): Result<Settings, ValidationError> => {
  switch (key) {
    case 'ai.provider': {
      return Result.error(
        new ValidationError({
          field: key,
          value: raw,
          message: 'setting ai.provider alone leaves models in an inconsistent state',
          hint: 'change ai.models.* first, then provider — or use a coordinated set-provider use-case (slice B)',
        })
      );
    }
    case 'ai.models.refine':
    case 'ai.models.plan':
    case 'ai.models.implement':
    case 'ai.models.readiness':
    case 'ai.models.ideate': {
      const which = key.split('.')[2] as 'refine' | 'plan' | 'implement' | 'readiness' | 'ideate';
      return Result.ok({
        ...current,
        ai: { ...current.ai, models: { ...current.ai.models, [which]: raw } } as Settings['ai'],
      });
    }
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
          hint: 'supported keys: ai.models.{refine,plan,implement,readiness,ideate}, harness.{maxTurns,maxAttempts,rateLimitRetries,plateauThreshold}, logging.level, concurrency.maxParallelTasks, ui.notifications.enabled',
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
