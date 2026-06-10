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
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';

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
 * Parse-time self-heal for the `maxTurns ≥ plateauThreshold` cross-knob invariant.
 *
 * `maxTurns` as low as 1 was fully valid before the invariant landed, so a persisted
 * `settings.json` tuned for fast iteration would FAIL the parse on upgrade — bricking the TUI
 * launch AND every CLI command including `ralphctl settings set`, the product's own repair tool.
 * Like {@link promoteLegacyAiRows}, the heal happens silently at parse time (no schemaVersion
 * bump; the canonical pair lands on the next save).
 *
 * Heal rule: preserve the operator's turn budget where the floors allow — clamp
 * `plateauThreshold` down to `max(2, maxTurns)` (2 is the schema floor), then raise `maxTurns`
 * up to that threshold only when forced (i.e. `maxTurns === 1` becomes the minimum legal pair
 * `(2, 2)`). A missing `plateauThreshold` uses the schema default (3) for the comparison so a
 * legacy `{ maxTurns: 1 }` file heals instead of tripping the refine after defaulting.
 */
const healHarnessCrossKnobs = (harness: unknown): unknown => {
  if (typeof harness !== 'object' || harness === null) return harness;
  const h = harness as Record<string, unknown>;
  const turns = h['maxTurns'];
  if (typeof turns !== 'number' || !Number.isInteger(turns)) return harness;
  const rawThreshold = h['plateauThreshold'];
  const threshold = typeof rawThreshold === 'number' && Number.isInteger(rawThreshold) ? rawThreshold : 3;
  if (turns >= threshold) return harness;
  const healedThreshold = Math.max(2, Math.min(threshold, turns));
  const healedTurns = Math.max(turns, healedThreshold);
  return { ...h, maxTurns: healedTurns, plateauThreshold: healedThreshold };
};

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
  harness: z.preprocess(
    healHarnessCrossKnobs,
    z
      .object({
        /** Generator–evaluator turns budgeted per `Attempt` (1–10). */
        maxTurns: z.number().int().min(1).max(10),
        /** Default cap on attempts per task before transitioning to `blocked` (1–10). */
        maxAttempts: z.number().int().min(1).max(10),
        /** Adapter-side retries on `RateLimitError` before surfacing the failure (0–10). */
        rateLimitRetries: z.number().int().min(0).max(10),
        /**
         * Consecutive evaluator turns flagging the same failed-dimension set before the loop
         * exits with a `plateau` warning (2–5, default 3 — patient: the graduated remedy ladder
         * climbs cheapest-first across plateaus, so a slightly higher threshold avoids spending an
         * escalation rung on a stall the generator would have broken on its own). See
         * `business/task/plateau-detection.ts` for the exemption rules (score improvement /
         * commit-message change / critique-prose shift) that can soften or skip the plateau even
         * when the threshold is met.
         */
        plateauThreshold: z.number().int().min(2).max(5).default(3),
        /**
         * Master switch for failure-driven generator-model escalation. The flag name is retained for
         * backward compatibility, but it now gates ALL failure-driven escalation — not only plateau:
         * `plateau` AND `budget-exhausted` (the turn budget ran out without a terminal verdict) exits
         * both climb the ladder, and `malformed` exits (the evaluator emitted no parseable verdict) get
         * a plain same-model fresh-attempt retry — instead of settling immediately.
         *
         * On an escalatable exit the generator climbs one rung up the merged ladder ({@link
         * escalationMap} over the built-in `DEFAULT_ESCALATION_MAP`) across successive failures, bounded
         * by `maxAttempts`; each climb hands the targeted prior critique to the stronger model. The
         * "change your approach" directive is NOT injected on a model bump — it fires only once the
         * generator reaches the top of the ladder, as a same-model nudge (one more attempt on the same
         * model, where no fresh capability remains so a change of approach is the only lever). A
         * malformed exit never burns a ladder rung (it is the evaluator's failure, not the generator's)
         * — it retries on the same model while budget remains.
         *
         * A failure-driven retry never blocks: after the ladder tops out (a further failure on the
         * nudged top-tier model) or the attempt budget is exhausted, the work is preserved
         * (done-with-warning). Defaults `true`.
         */
        escalateOnPlateau: z.boolean().default(true),
        /**
         * User overrides for the built-in `DEFAULT_ESCALATION_MAP` (in
         * `business/task/escalation-map.ts`). Keys are the current model id, values the model id
         * to escalate to. Empty by default; merged at read time with user keys winning on
         * conflict and extending the default ladder. Non-string entries fail schema validation
         * with a typed Zod error naming the offending field.
         */
        escalationMap: z.record(z.string(), z.string()).default({}),
        /**
         * Opt-in fast path: skip the FIRST pre-task verify of a launch when this launch's own
         * setup script already built+tested the same tree. Defaults `false` so existing users see
         * zero behaviour change — flipping it on is an explicit assertion that "my setup script
         * verifies the tree", not merely that it installs dependencies.
         *
         * When `true`, the `pre-task-verify` leaf synthesizes a green baseline (instead of
         * re-running the verify gate) for the first task on each repo, but ONLY when ALL hold:
         * this launch's setup run for that repo succeeded, the working tree is clean, and no prior
         * task on the same cwd has already carried a green post-verify baseline (the existing
         * carry-baseline short-circuit owns that case). This eliminates the redundant verify the
         * first task of every run otherwise pays seconds after setup already proved the tree green.
         *
         * CAVEAT — the skip is only sound when the setup script ACTUALLY VERIFIES the tree (builds
         * + runs the test gate). A setup script that merely installs dependencies (`pnpm install`,
         * `mvn dependency:go-offline`) validates nothing: with this flag on, the skip would hide a
         * pre-broken baseline, and a later red post-verify on that same tree would be mis-attributed
         * to the AI's work rather than the inherited breakage. Leave this `false` unless your setup
         * gate is a full verify.
         */
        skipPreVerifyOnFreshSetup: z.boolean().default(false),
      })
      .superRefine((harness, ctx) => {
        /**
         * Cross-knob invariant: `maxTurns` must be ≥ `plateauThreshold`.
         *
         * `plateauHistory` resets at the start of each attempt — `computePlateauVerdict` needs
         * `plateauThreshold` consecutive failed turns within ONE attempt to fire. When
         * `maxTurns < plateauThreshold` the turn budget runs out before the plateau window can fill,
         * so `escalateOnPlateau` and its remedies (model escalation, nudge) become permanently
         * unreachable for every attempt regardless of generator output.
         *
         * Persisted records never trip this: {@link healHarnessCrossKnobs} self-heals legacy pairs
         * at parse time (maxTurns 1–2 was fully valid before the invariant landed; failing the
         * parse would brick the TUI AND the `settings set` repair command on upgrade). This refine
         * is the backstop for direct construction in code/tests and documents the invariant. The
         * defaults (maxTurns=5, plateauThreshold=3) satisfy it.
         */
        if (harness.maxTurns < harness.plateauThreshold) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['maxTurns'],
            message: `maxTurns (${String(harness.maxTurns)}) must be ≥ plateauThreshold (${String(harness.plateauThreshold)}); when maxTurns < plateauThreshold the plateau window can never fill within a single attempt and escalation becomes unreachable. Increase maxTurns or lower plateauThreshold.`,
          });
        }
      })
  ),
  logging: z.object({
    level: LogLevelSchema,
  }),
  concurrency: z.object({
    /**
     * Max tasks running in parallel within one sprint. `1` = strict serial execution.
     * Capped at `5`: above that, contention on the shared sprint branch's fold queue and on
     * the AI providers' rate limits dominates, and worktree churn outweighs the throughput
     * gain. The wave scheduler re-clamps to this same ceiling defensively.
     */
    maxParallelTasks: z.number().int().min(1).max(5),
  }),
  /**
   * Source-control-management preferences. Defaults the whole section so settings files
   * written before this section existed parse without a schema-version bump or migration —
   * the load path stamps the section in and the next `save()` writes it inline.
   */
  scm: z
    .object({
      /**
       * Governs the default reviewer choice for the refine flow's "Post as comment" action,
       * and — in non-interactive (CI / headless) runs — whether the refined requirements are
       * posted as a comment on the linked issue at all. Defaults `false`: the original issue
       * description is never touched, and posting a comment is strictly opt-in.
       */
      postRefinementComment: z.boolean().default(false),
    })
    .default({ postRefinementComment: false }),
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

/**
 * Compute the unique providers referenced across all per-flow rows, preserving the order
 * they first appear in `FLOW_IDS`. Used to decide which native context files to write — one
 * per unique provider (readiness fan-out, distill fan-out). For `implement` both the
 * generator and evaluator role's providers contribute, so a cross-provider implement still
 * produces both context files.
 *
 * Pure over {@link AiSettings} — no I/O — so it lives in the domain entity alongside
 * {@link primaryFlowRow} rather than in any one consuming flow.
 *
 * @public
 */
export const uniqueProvidersFromAi = (ai: AiSettings): readonly AiProvider[] => {
  const seen = new Set<AiProvider>();
  const ordered: AiProvider[] = [];
  const visit = (provider: AiProvider): void => {
    if (seen.has(provider)) return;
    seen.add(provider);
    ordered.push(provider);
  };
  for (const flow of FLOW_IDS) {
    if (flow === 'implement') {
      visit(ai.implement.generator.provider);
      visit(ai.implement.evaluator.provider);
      continue;
    }
    visit(ai[flow].provider);
  }
  return ordered;
};

// AiProviderSchema is intentionally not re-exported — callers should use the type alias
// above; only the schema module re-uses the runtime enum for parsing.
void AiProviderSchema;
