/**
 * Application-level `Config` shape.
 *
 * Config is an application concern (composition root + global runtime
 * settings), not a domain entity — it doesn't represent business state and
 * has no aggregate invariants. The composition root persists it through
 * the `ConfigStorePort`.
 *
 * Defaults live in {@link CONFIG_DEFAULTS} (see `./config-defaults.ts`).
 */
import type { LogLevel } from '../../business/ports/logger-port.ts';
import type { SprintId } from '../../domain/values/sprint-id.ts';

/** AI providers ralphctl can drive. */
export type AiProvider = 'claude' | 'copilot';

/**
 * Runtime configuration for a ralphctl install. All fields are required
 * at the type level — `ConfigStorePort.load()` always returns a fully
 * populated `Config` (missing or partial files fall back to defaults).
 */
export interface Config {
  /** Pointer to the sprint CLI commands target by default. `null` if none. */
  readonly currentSprint: SprintId | null;
  /** Selected AI provider; `null` until the user picks one. */
  readonly aiProvider: AiProvider | null;
  /** Override the editor used for multi-line prompts; `null` falls back to $EDITOR / Ink. */
  readonly editor: string | null;
  /** Evaluator iteration budget. `0` disables; default `1` gives one fix round. */
  readonly evaluationIterations: number;
  /** Default log level when `RALPHCTL_LOG_LEVEL` is unset. */
  readonly logLevel: LogLevel;
}
