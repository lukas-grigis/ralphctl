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
import type { FlowId } from '@src/domain/value/flow-id.ts';

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
 * Implement runs two AI sessions per attempt — a generator that produces the change and an
 * evaluator that scores it. Each role carries its own per-flow row so they can run on
 * different providers / models / effort levels. The roles share the same row shape; only the
 * `implement` slot under `ai` carries this pair, every other flow stays on the flat row.
 */
const AiImplementSchema = z.object({
  generator: FlowRowSchema,
  evaluator: FlowRowSchema,
});

/**
 * Promote a legacy flat `implement: { provider, model, effort? }` object — written by
 * ralphctl ≤ 0.7.0 — into the nested `{ generator, evaluator }` shape both roles use the
 * same row. Runs at parse time without bumping {@link CURRENT_SCHEMA_VERSION}; the next
 * `save()` rewrites the file in the new shape so the promotion only fires once per file.
 *
 * Returns the input untouched when the slot is already nested or when the shape doesn't
 * match a legacy flat row — schema validation then surfaces the real error message.
 */
const promoteLegacyImplementRow = (ai: unknown): unknown => {
  if (typeof ai !== 'object' || ai === null) return ai;
  const aiObj = ai as Record<string, unknown>;
  const implement = aiObj['implement'];
  if (typeof implement !== 'object' || implement === null) return ai;
  const implObj = implement as Record<string, unknown>;
  // Already nested — leave alone.
  if ('generator' in implObj || 'evaluator' in implObj) return ai;
  // Flat shape: must carry a `provider` field (the discriminator). Anything else is a
  // malformed input we hand to the schema for a proper error message.
  if (!('provider' in implObj)) return ai;
  const promoted = { generator: implObj, evaluator: implObj };
  return { ...aiObj, implement: promoted };
};

/**
 * Seed `ai.createPr` from `ai.refine` when the row is absent — settings files written by
 * ralphctl ≤ 0.8.x had no dedicated create-pr row and the harness reused `ai.refine.model`
 * for the optional PR-content AI step. Runs at parse time without bumping
 * {@link CURRENT_SCHEMA_VERSION}; the next `save()` rewrites the file with the new row
 * inlined so the seeding only fires once per file. Same silence policy as
 * {@link promoteLegacyImplementRow}: no user notice.
 *
 * Returns the input untouched when `createPr` already exists or when `refine` isn't a
 * usable row — schema validation then surfaces the real error message.
 */
const seedLegacyCreatePrRow = (ai: unknown): unknown => {
  if (typeof ai !== 'object' || ai === null) return ai;
  const aiObj = ai as Record<string, unknown>;
  if ('createPr' in aiObj) return ai;
  const refine = aiObj['refine'];
  if (typeof refine !== 'object' || refine === null) return ai;
  if (!('provider' in (refine as Record<string, unknown>))) return ai;
  // Shallow-copy refine into createPr — the schema's discriminated row union validates
  // both rows independently, so a stale shape on refine surfaces twice (once per row).
  return { ...aiObj, createPr: { ...(refine as Record<string, unknown>) } };
};

/** Retired Claude model slug and its catalog successor — rewritten at parse time. */
const RETIRED_CLAUDE_OPUS = 'claude-opus-4-7';
const SUCCESSOR_CLAUDE_OPUS = 'claude-opus-4-8';

/** Rewrite a single row in place when it pins the retired Claude Opus model. */
const migrateRetiredOpusRow = (row: unknown): unknown => {
  if (typeof row !== 'object' || row === null) return row;
  const rowObj = row as Record<string, unknown>;
  if (rowObj['provider'] === 'claude-code' && rowObj['model'] === RETIRED_CLAUDE_OPUS) {
    return { ...rowObj, model: SUCCESSOR_CLAUDE_OPUS };
  }
  return row;
};

/**
 * Rewrite any AI row pinned to the now-removed Claude model `claude-opus-4-7` to its catalog
 * successor `claude-opus-4-8`. The settings schema accepts off-catalog model strings, so a
 * persisted `claude-opus-4-7` row LOADS fine — but the Claude adapter rejects non-catalog
 * models at spawn time with `InvalidStateError`. Rewriting at parse time keeps existing users
 * on a working model across the catalog change.
 *
 * Covers the five flat rows (`refine` / `plan` / `readiness` / `ideate` / `createPr`) and the
 * nested `implement.{generator,evaluator}` pair. Runs at parse time without bumping
 * {@link CURRENT_SCHEMA_VERSION}; the next `save()` rewrites the file with the new slug so the
 * migration only fires once per file. Same silence policy as {@link promoteLegacyImplementRow}
 * and {@link seedLegacyCreatePrRow}: no user notice.
 *
 * Returns the input untouched for non-object / null shapes — it runs on raw `unknown` before
 * validation, so schema validation still surfaces the real error message for malformed input.
 */
const migrateRetiredClaudeOpus = (ai: unknown): unknown => {
  if (typeof ai !== 'object' || ai === null) return ai;
  const aiObj = ai as Record<string, unknown>;
  const next: Record<string, unknown> = { ...aiObj };
  for (const flow of ['refine', 'plan', 'readiness', 'ideate', 'createPr'] as const) {
    if (flow in next) next[flow] = migrateRetiredOpusRow(next[flow]);
  }
  const implement = next['implement'];
  if (typeof implement === 'object' && implement !== null) {
    const implObj = implement as Record<string, unknown>;
    next['implement'] = {
      ...implObj,
      generator: migrateRetiredOpusRow(implObj['generator']),
      evaluator: migrateRetiredOpusRow(implObj['evaluator']),
    };
  }
  return next;
};

/**
 * Compose the parse-time preprocessors so they all fire on every parse. Order matters:
 * {@link migrateRetiredClaudeOpus} runs LAST so it sees the implement row already nested into
 * `{ generator, evaluator }` (so a legacy flat `claude-opus-4-7` implement row migrates both
 * roles) and the createPr row already seeded from refine (so a 4-7 seeded createPr migrates too).
 */
const promoteLegacyAiRows = (ai: unknown): unknown =>
  migrateRetiredClaudeOpus(seedLegacyCreatePrRow(promoteLegacyImplementRow(ai)));

/**
 * Per-flow AI settings:
 *
 *   ai.effort?            // global default, used when a row omits its own effort
 *   ai.refine             // { provider, model, effort? }
 *   ai.plan               // { provider, model, effort? }
 *   ai.implement          // { generator: { provider, model, effort? }, evaluator: {...} }
 *   ai.readiness          // { provider, model, effort? }
 *   ai.ideate             // { provider, model, effort? }
 *   ai.createPr           // { provider, model, effort? }
 *
 * Rows are independent — refine can run on Claude while implement.evaluator runs on Codex.
 * The discriminated union on each row keeps `model` enforced against the row's provider
 * catalog. Implement splits into a generator/evaluator pair because those two sessions
 * benefit from different reasoning profiles; every other flow runs a single AI session.
 *
 * The `createPr` row was added after the original five — settings files written by
 * ralphctl ≤ 0.8.x are missing it. The preprocess seeds it from `refine` at parse time so
 * legacy files load without manual editing; the next `save()` rewrites the canonical shape.
 */
const AiSettingsSchema = z.preprocess(
  promoteLegacyAiRows,
  z.object({
    effort: GlobalEffortSchema.optional(),
    refine: FlowRowSchema,
    plan: FlowRowSchema,
    implement: AiImplementSchema,
    readiness: FlowRowSchema,
    ideate: FlowRowSchema,
    createPr: FlowRowSchema,
  })
);

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
    /**
     * When the gen-eval loop exits on a plateau, escalate the generator's model one rung up
     * the ladder defined by {@link escalationMap} (merged with the built-in
     * `DEFAULT_ESCALATION_MAP`) and reissue the attempt instead of transitioning the task
     * straight to `blocked`. Defaults `false` — the runtime wiring lands in a follow-up task.
     */
    escalateOnPlateau: z.boolean().default(false),
    /**
     * User overrides for the built-in `DEFAULT_ESCALATION_MAP` (in
     * `business/task/escalation-map.ts`). Keys are the current model id, values the model id
     * to escalate to. Empty by default; merged at read time with user keys winning on
     * conflict and extending the default ladder. Non-string entries fail schema validation
     * with a typed Zod error naming the offending field.
     */
    escalationMap: z.record(z.string(), z.string()).default({}),
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
/**
 * Generator + evaluator pair under `settings.ai.implement`. Exposed for subsequent tasks in
 * the #131 generator/evaluator-split initiative — `settings-set-provider` accepts an
 * `AiImplementRole` today, and downstream consumers will read this type when wiring per-role
 * provider / model selection at the implement launcher and gen-eval leaves.
 */
export type AiImplementSettings = z.infer<typeof AiImplementSchema>;
/** Roles inside {@link AiImplementSettings} — addressed in dotted-path keys and per-leaf launches. */
export type AiImplementRole = 'generator' | 'evaluator';
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Resolve the primary {@link AiFlowSettings} row for `flow` — the row legacy single-session
 * consumers (provider factory, readiness inventory, settings TUI) read when they only know
 * how to spawn one AI per flow. For `implement` this returns the generator role; every other
 * flow already has exactly one row. Call sites that genuinely need both implement roles read
 * `ai.implement.generator` / `ai.implement.evaluator` directly.
 */
export const primaryFlowRow = (ai: AiSettings, flow: FlowId): AiFlowSettings => {
  if (flow === 'implement') return ai.implement.generator;
  return ai[flow];
};

// AiProviderSchema is intentionally not re-exported — callers should use the type alias
// above; only the schema module re-uses the runtime enum for parsing.
void AiProviderSchema;
