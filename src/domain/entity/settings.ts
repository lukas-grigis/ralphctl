/**
 * User-facing application settings — the persisted preferences a user can read and mutate
 * via the TUI's Settings view or `ralphctl settings` CLI. Distinct from `bootstrap/`
 * concerns (storage paths, env-derived data) which stay in the composition root.
 *
 * Validation lives here so domain invariants — provider matches its model catalog, numeric
 * ranges, enum membership — are enforced once. The persistence adapter
 * (`adapters/persistence/settings/`) reuses {@link SettingsSchema} for round-trip parsing
 * so a malformed file surfaces as a typed `ParseError` rather than a half-decoded record.
 */

import { z } from 'zod';
import type { LogLevel } from '@src/domain/value/log-level.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';

/**
 * Persisted settings format version. Bumped whenever the on-disk shape changes in a way that
 * isn't structurally backwards compatible (renamed field, dropped field, changed enum). Each
 * bump ships with a forward migration in `migrations.ts`; the load path runs pending
 * migrations and re-saves the file so the user never has to edit JSON by hand.
 */
export const CURRENT_SCHEMA_VERSION = 2 as const;

const LogLevelSchema = z.enum(['silent', 'debug', 'info', 'warn', 'error']) satisfies z.ZodType<LogLevel>;

/**
 * Provider identifier — closed set. Lives as a standalone alias (rather than derived from a
 * Zod literal) because the flat AiSettings shape no longer has a `provider` field at the root
 * for `z.infer` to project. Used by every per-flow row and by composition-root factories.
 */
export type AiProvider = 'claude-code' | 'github-copilot' | 'openai-codex';

const AiProviderSchema = z.enum(['claude-code', 'github-copilot', 'openai-codex']) satisfies z.ZodType<AiProvider>;

/**
 * Effort-level vocabularies, per provider. Each row's `effort` value is checked against the
 * provider's native enum at parse time (a Copilot-only level on a Claude row would surface as
 * a schema error). The unified global `ai.effort` accepts the superset; `resolveEffort` floors
 * it to a provider-supported level at read time.
 */
const ClaudeEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const CopilotEffortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const CodexEffortSchema = z.enum(['minimal', 'low', 'medium', 'high']);

/** Superset across providers. The global `ai.effort` accepts any of these; `resolveEffort` floors. */
const GlobalEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Custom (off-catalog) model id. Users can pin to a model the harness doesn't know about by
 * typing it directly — the schema only requires non-empty trimmed input, the CLI adapter is
 * still expected to reject unknowns at spawn time.
 */
const CustomModelStringSchema = z.string().trim().min(1, 'model id must be a non-empty trimmed string');

const ClaudeModelSchema = z.union([z.enum(CLAUDE_MODELS as readonly [string, ...string[]]), CustomModelStringSchema]);
const CopilotModelSchema = z.union([z.enum(COPILOT_MODELS as readonly [string, ...string[]]), CustomModelStringSchema]);
const CodexModelSchema = z.union([z.enum(CODEX_MODELS as readonly [string, ...string[]]), CustomModelStringSchema]);

const ClaudeFlowRowSchema = z.object({
  provider: z.literal('claude-code'),
  model: ClaudeModelSchema,
  effort: ClaudeEffortSchema.optional(),
});

const CopilotFlowRowSchema = z.object({
  provider: z.literal('github-copilot'),
  model: CopilotModelSchema,
  effort: CopilotEffortSchema.optional(),
});

const CodexFlowRowSchema = z.object({
  provider: z.literal('openai-codex'),
  model: CodexModelSchema,
  effort: CodexEffortSchema.optional(),
});

const FlowRowSchema = z.discriminatedUnion('provider', [ClaudeFlowRowSchema, CopilotFlowRowSchema, CodexFlowRowSchema]);

/**
 * Flat per-flow AI settings:
 *
 *   ai.effort?            // global default, used when a row omits its own effort
 *   ai.refine             // { provider, model, effort? }
 *   ai.plan               // { provider, model, effort? }
 *   ai.implement          // { provider, model, effort? }
 *   ai.readiness          // { provider, model, effort? }
 *   ai.ideate             // { provider, model, effort? }
 *
 * Rows are independent — refine can run on Claude while implement runs on Codex. The
 * discriminated union on each row keeps `model` enforced against the row's provider catalog.
 */
const AiSettingsSchema = z.object({
  effort: GlobalEffortSchema.optional(),
  refine: FlowRowSchema,
  plan: FlowRowSchema,
  implement: FlowRowSchema,
  readiness: FlowRowSchema,
  ideate: FlowRowSchema,
});

export const SettingsSchema = z.object({
  /**
   * On-disk format version. Omitted in the very first format (treated as v1 by the load path
   * before validation); always written by the save path. Migrations run *before* this schema
   * sees a file, so the value is always {@link CURRENT_SCHEMA_VERSION} by the time we parse.
   */
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION).default(CURRENT_SCHEMA_VERSION),
  ai: AiSettingsSchema,
  harness: z.object({
    /** Generator–evaluator turns budgeted per `Attempt` (1–10). */
    maxTurns: z.number().int().min(1).max(10),
    /** Default cap on attempts per task before transitioning to `blocked` (1–10). */
    maxAttempts: z.number().int().min(1).max(10),
    /** Adapter-side retries on `RateLimitError` before surfacing the failure (0–10). */
    rateLimitRetries: z.number().int().min(0).max(10),
    /**
     * Consecutive evaluator turns flagging the same failed-dimension set before the loop
     * exits with a `plateau` warning (2–5). Setting to 3+ gives the AI extra retries before
     * the harness gives up. See `business/task/plateau-detection.ts` for the exemption rules
     * (score improvement / commit-message change / critique-prose shift) that can soften or
     * skip the plateau even when the threshold is met.
     */
    plateauThreshold: z.number().int().min(2).max(5).default(2),
  }),
  logging: z.object({
    level: LogLevelSchema,
  }),
  concurrency: z.object({
    /** Max tasks running in parallel within one sprint. `1` = strict serial execution. */
    maxParallelTasks: z.number().int().min(1),
  }),
  ui: z
    .object({
      notifications: z
        .object({
          /**
           * Master switch for OS-level attention notifications (terminal bell + Darwin
           * NotificationCenter / Linux libnotify). Defaults `true`; users on shared workstations
           * or in muted-headphones environments can flip this off to suppress every notify call.
           * Read on each event so a runtime toggle takes effect immediately.
           */
          enabled: z.boolean().default(true),
        })
        .default({ enabled: true }),
    })
    .default({ notifications: { enabled: true } }),
  /**
   * Developer-only feature toggles. These default to `false` and are not surfaced in the
   * Settings UI — they are gates for behaviour the team is still validating against real
   * sprint data before promoting to the default render path.
   */
  developer: z
    .object({
      /**
       * Render the per-dimension evaluator-failure panel inside the Tasks panel when an
       * attempt's evaluator verdict is `failed`. Defaults `false`; production still renders
       * the canonical 4-line dimension summary. When `true` the panel shows each dimension's
       * score colour-coded red / green plus the critique excerpt with an expand affordance.
       */
      showEvaluatorFailureUI: z.boolean().default(false),
    })
    .default({ showEvaluatorFailureUI: false }),
});

export type AiSettings = z.infer<typeof AiSettingsSchema>;
/** Discriminated row type — one entry per flow under `settings.ai.<flow>`. */
export type AiFlowSettings = z.infer<typeof FlowRowSchema>;
export type Settings = z.infer<typeof SettingsSchema>;

// AiProviderSchema is intentionally not re-exported — callers should use the type alias
// above; only the schema module re-uses the runtime enum for parsing.
void AiProviderSchema;
