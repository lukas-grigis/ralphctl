/**
 * User-facing settings — persisted preferences read and mutated via the TUI Settings view or
 * `ralphctl settings`. Validation lives here so domain invariants are enforced once; the
 * persistence adapter reuses {@link SettingsSchema}, so a malformed file surfaces as a typed
 * `ParseError` rather than a half-decoded record.
 */

import { z } from 'zod';
import type { LogLevel } from '@src/domain/value/log-level.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';
import { OPENCODE_MODELS } from '@src/domain/value/settings-models/opencode.ts';
import { GROK_MODELS } from '@src/domain/value/settings-models/grok.ts';
import { PROVIDER_EFFORT_LEVELS } from '@src/domain/value/settings-models/effort.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';

/**
 * Persisted settings format version. Bumped when the on-disk shape changes incompatibly; each bump
 * ships a forward migration in `migrations.ts` that the load path runs and re-saves.
 */
export const CURRENT_SCHEMA_VERSION = 2 as const;

const LogLevelSchema = z.enum(['silent', 'debug', 'info', 'warn', 'error']) satisfies z.ZodType<LogLevel>;

// Hoisted: `sonarjs/no-duplicate-string` trips on the raw ids repeated in RETIRED_MODEL_REMAPS.
const PROVIDER_CLAUDE_CODE = 'claude-code';
const PROVIDER_GITHUB_COPILOT = 'github-copilot';
const PROVIDER_OPENAI_CODEX = 'openai-codex';
const PROVIDER_OPENCODE = 'opencode';
const PROVIDER_XAI_GROK = 'xai-grok';

const AI_PROVIDER_IDS = [
  PROVIDER_CLAUDE_CODE,
  PROVIDER_GITHUB_COPILOT,
  PROVIDER_OPENAI_CODEX,
  PROVIDER_OPENCODE,
  PROVIDER_XAI_GROK,
] as const;

export type AiProvider = (typeof AI_PROVIDER_IDS)[number];

/** Superset across providers. The global `ai.effort` accepts any of these; `resolveEffort` floors. */
const GlobalEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

/** Off-catalog model id: only non-empty trimmed input is required; the adapter still rejects unknowns at spawn. */
const CustomModelStringSchema = z.string().trim().min(1, 'model id must be a non-empty trimmed string');

/**
 * One provider's flow row. `effort` is checked against that provider's own vocabulary
 * ({@link PROVIDER_EFFORT_LEVELS}), so a Copilot-only level on a Claude row is a schema error.
 */
const flowRow = <P extends AiProvider, M extends readonly [string, ...string[]]>(provider: P, models: M) =>
  z.object({
    provider: z.literal(provider),
    model: z.union([z.enum(models), CustomModelStringSchema]),
    effort: z.enum(PROVIDER_EFFORT_LEVELS[provider]).optional(),
  });

const FlowRowSchema = z.discriminatedUnion('provider', [
  flowRow(PROVIDER_CLAUDE_CODE, CLAUDE_MODELS),
  flowRow(PROVIDER_GITHUB_COPILOT, COPILOT_MODELS),
  flowRow(PROVIDER_OPENAI_CODEX, CODEX_MODELS),
  // OpenCode's catalog is only the zero-auth free-tier floor: an authenticated `anthropic/…` id must
  // round-trip, so the custom arm is load-bearing here rather than a fallback.
  flowRow(PROVIDER_OPENCODE, OPENCODE_MODELS),
  flowRow(PROVIDER_XAI_GROK, GROK_MODELS),
]);

/**
 * Agent-definition name bound to an implement role. Validity against the catalog is checked at
 * launch (an unknown name is a harmless no-op) — the domain cannot see the integration-side sources.
 */
const AgentBindingNameSchema = z.string().trim().min(1, 'agent definition name must be a non-empty trimmed string');

/** Opt-in per-role binding; an absent role (or block) runs the session without a delegated persona. */
const AiAgentBindingsSchema = z.object({
  generator: AgentBindingNameSchema.optional(),
  evaluator: AgentBindingNameSchema.optional(),
});

/** Implement runs a generator and an evaluator session per attempt, each on its own row. */
const AiImplementSchema = z.object({
  generator: FlowRowSchema,
  evaluator: FlowRowSchema,
  agents: AiAgentBindingsSchema.optional(),
});

/*
 * Parse-time preprocessors below heal legacy shapes silently, without bumping
 * CURRENT_SCHEMA_VERSION; the next `save()` writes the canonical shape, so each fires once per file.
 * Each returns its input untouched when the shape doesn't match, leaving the schema to report the
 * real error.
 */

/** Promote a ≤ 0.7.0 flat `implement: { provider, model, effort? }` row to `{ generator, evaluator }`. */
const promoteLegacyImplementRow = (ai: unknown): unknown => {
  if (typeof ai !== 'object' || ai === null) return ai;
  const aiObj = ai as Record<string, unknown>;
  const implement = aiObj['implement'];
  if (typeof implement !== 'object' || implement === null) return ai;
  const implObj = implement as Record<string, unknown>;
  if ('generator' in implObj || 'evaluator' in implObj) return ai;
  if (!('provider' in implObj)) return ai;
  return { ...aiObj, implement: { generator: implObj, evaluator: implObj } };
};

/** Seed a missing `ai.createPr` (≤ 0.8.x files) from `ai.refine`, which the PR step used to reuse. */
const seedLegacyCreatePrRow = (ai: unknown): unknown => {
  if (typeof ai !== 'object' || ai === null) return ai;
  const aiObj = ai as Record<string, unknown>;
  if ('createPr' in aiObj) return ai;
  const refine = aiObj['refine'];
  if (typeof refine !== 'object' || refine === null) return ai;
  if (!('provider' in (refine as Record<string, unknown>))) return ai;
  return { ...aiObj, createPr: { ...(refine as Record<string, unknown>) } };
};

const COPILOT_GEMINI_SUCCESSOR = 'gemini-3.8-flash';
// GitHub's named successor for Opus 4.8 / 5, which retire on Copilot 2026-11-16.
const COPILOT_OPUS_SUCCESSOR = 'claude-opus-5.5';
const COPILOT_SMALL_CODE_SUCCESSOR = 'mai-code-1.1-flash';
// GitHub's named successors for the 2026-10-19 GPT deprecations; also Codex's `gpt-5.5` successor.
const GPT_5_6_SOL = 'gpt-5.6-sol';
const GPT_5_6_LUNA = 'gpt-5.6-luna';

/**
 * Retired model slugs and their catalog successors, per provider — rewritten at parse time.
 * Provider-guarded: a slug can retire on one backend and stay live on another (`grok-4.5` is gone
 * from Copilot, live on xai-grok). Every `to` is a LIVE catalog id, so one hop always lands on a
 * runnable model — when a successor itself retires, older entries are re-targeted (chain collapse).
 * The test suite asserts both properties.
 */
export const RETIRED_MODEL_REMAPS: ReadonlyArray<{
  readonly provider: AiProvider;
  readonly from: string;
  readonly to: string;
}> = [
  { provider: PROVIDER_CLAUDE_CODE, from: 'claude-opus-4-7', to: 'claude-opus-4-8' },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'claude-opus-4.5', to: COPILOT_OPUS_SUCCESSOR },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'claude-opus-4.6', to: COPILOT_OPUS_SUCCESSOR },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'claude-opus-4.6-fast', to: 'claude-opus-4.8-fast' },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'claude-sonnet-4.5', to: 'claude-sonnet-5' },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'claude-sonnet-4.6', to: 'claude-sonnet-5' },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'gemini-3.1-pro', to: COPILOT_GEMINI_SUCCESSOR },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'gemini-3.1-pro-preview', to: COPILOT_GEMINI_SUCCESSOR },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'gemini-2.5-pro', to: COPILOT_GEMINI_SUCCESSOR },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'gemini-3-flash', to: COPILOT_GEMINI_SUCCESSOR },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'gemini-3.5-flash', to: COPILOT_GEMINI_SUCCESSOR },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'gemini-3.6-flash', to: COPILOT_GEMINI_SUCCESSOR },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'kimi-k2.7-code', to: 'kimi-k3' },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'claude-opus-4.7', to: COPILOT_OPUS_SUCCESSOR },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'raptor-mini', to: COPILOT_SMALL_CODE_SUCCESSOR },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'raptor-mini-preview', to: COPILOT_SMALL_CODE_SUCCESSOR },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'mai-code-1-flash', to: COPILOT_SMALL_CODE_SUCCESSOR },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'gpt-5.5', to: GPT_5_6_SOL },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'gpt-5.4', to: GPT_5_6_SOL },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'gpt-5.4-mini', to: GPT_5_6_LUNA },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'gpt-5-mini', to: GPT_5_6_LUNA },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'gemini-3.7-flash', to: COPILOT_GEMINI_SUCCESSOR },
  { provider: PROVIDER_GITHUB_COPILOT, from: 'grok-4.5', to: 'grok-4.6' },
  { provider: PROVIDER_OPENAI_CODEX, from: 'gpt-5.5', to: GPT_5_6_SOL },
  { provider: PROVIDER_OPENAI_CODEX, from: 'gpt-5.4', to: 'gpt-6-sol' },
  { provider: PROVIDER_OPENAI_CODEX, from: 'gpt-5.4-mini', to: 'gpt-6-luna' },
  { provider: PROVIDER_OPENAI_CODEX, from: 'gpt-5.2', to: GPT_5_6_SOL },
  { provider: PROVIDER_OPENAI_CODEX, from: 'gpt-5.3-codex', to: GPT_5_6_SOL },
  { provider: PROVIDER_OPENAI_CODEX, from: 'gpt-5.3-codex-spark', to: GPT_5_6_SOL },
  { provider: PROVIDER_OPENCODE, from: 'opencode/deepseek-v4-flash-free', to: 'opencode/nemotron-3.5-lightning-free' },
  { provider: PROVIDER_OPENCODE, from: 'opencode/ling-3.0-tiny-free', to: 'opencode/ling-3.0-flash-fin-free' },
  { provider: PROVIDER_OPENCODE, from: 'opencode/mimo-v2.5-free', to: 'opencode/mimo-v2.6-flash-free' },
  {
    provider: PROVIDER_OPENCODE,
    from: 'opencode/muse-spark-1.2-contributor-free',
    to: 'opencode/muse-spark-1.3-contributor-free',
  },
];

/**
 * The live successor of a retired (`provider`, `model`) pair, else `model` unchanged. Also used for
 * persisted model ids outside the settings file (a task's `escalatedToModel`). Takes the provider as
 * a plain string; an unknown provider matches nothing.
 */
export const remapRetiredModel = (provider: string, model: string): string =>
  RETIRED_MODEL_REMAPS.find((r) => r.provider === provider && r.from === model)?.to ?? model;

/** Every static catalog id, across providers — the "is this slug live anywhere?" probe. */
const LIVE_CATALOG_IDS: ReadonlySet<string> = new Set<string>([
  ...CLAUDE_MODELS,
  ...COPILOT_MODELS,
  ...CODEX_MODELS,
  ...OPENCODE_MODELS,
  ...GROK_MODELS,
]);

/**
 * The successor of a retired `model` when that is unambiguous without a provider — no catalog still
 * lists it and every retirement names the same successor — else `undefined`. For provider-less
 * references like `harness.escalationMap` values: `grok-4.5` is live on xai-grok, and `gpt-5.4` maps
 * differently on codex and Copilot, so both are left for the caller to warn on.
 */
export const unambiguousRetiredSuccessor = (model: string): string | undefined => {
  if (LIVE_CATALOG_IDS.has(model)) return undefined;
  const successors = new Set(RETIRED_MODEL_REMAPS.filter((r) => r.from === model).map((r) => r.to));
  return successors.size === 1 ? [...successors][0] : undefined;
};

/** Codex retired the 'minimal' reasoning-effort level (codex CLI >= 0.145); 'low' succeeds it. */
const RETIRED_CODEX_EFFORT = 'minimal';
/** Levels the Grok CLI refuses on every catalog model; 'low' is the nearest it accepts. */
const RETIRED_GROK_EFFORTS: ReadonlySet<unknown> = new Set(['none', RETIRED_CODEX_EFFORT]);

const isRetiredEffort = (provider: unknown, effort: unknown): boolean =>
  (provider === PROVIDER_OPENAI_CODEX && effort === RETIRED_CODEX_EFFORT) ||
  (provider === PROVIDER_XAI_GROK && RETIRED_GROK_EFFORTS.has(effort));

/** Rewrite one row: retired-model remap by (provider, model), then retired effort levels -> 'low'. */
const migrateStaleRow = (row: unknown): unknown => {
  if (typeof row !== 'object' || row === null) return row;
  let next = row as Record<string, unknown>;
  const provider = next['provider'];
  const model = next['model'];
  if (typeof provider === 'string' && typeof model === 'string') {
    const remapped = remapRetiredModel(provider, model);
    if (remapped !== model) next = { ...next, model: remapped };
  }
  if (isRetiredEffort(next['provider'], next['effort'])) {
    next = { ...next, effort: 'low' };
  }
  return next;
};

/**
 * Migrate every AI row (flat flows plus both implement roles) off retired models and efforts. The
 * schema accepts off-catalog strings, so a retired row would LOAD fine and then fail at spawn.
 */
const migrateStaleAiRows = (ai: unknown): unknown => {
  if (typeof ai !== 'object' || ai === null) return ai;
  const aiObj = ai as Record<string, unknown>;
  const next: Record<string, unknown> = { ...aiObj };
  for (const flow of FLOW_IDS) {
    if (flow === 'implement' || !(flow in next)) continue;
    next[flow] = migrateStaleRow(next[flow]);
  }
  const implement = next['implement'];
  if (typeof implement === 'object' && implement !== null) {
    const implObj = implement as Record<string, unknown>;
    next['implement'] = {
      ...implObj,
      generator: migrateStaleRow(implObj['generator']),
      evaluator: migrateStaleRow(implObj['evaluator']),
    };
  }
  return next;
};

// Order matters: migrate LAST so it sees the promoted implement pair and the seeded createPr row.
const promoteLegacyAiRows = (ai: unknown): unknown =>
  migrateStaleAiRows(seedLegacyCreatePrRow(promoteLegacyImplementRow(ai)));

/**
 * Self-heal the `maxTurns ≥ plateauThreshold` invariant. `maxTurns` 1–2 was valid before it landed,
 * and failing the parse would brick the TUI and `settings set`, the repair tool itself. Keeps the
 * operator's turn budget where the floors allow: clamp the threshold to `max(2, maxTurns)`, then
 * raise `maxTurns` only when forced. A missing threshold compares as the schema default (3).
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
 * Remap `escalationMap` VALUES that point at a retired model, when the retirement is unambiguous
 * (ambiguous ones warn at load via `warnEscalationMapRetiredValues`). Keys stay: a retired key is
 * merely dead, since settings rows are already remapped.
 */
const remapRetiredEscalationTargets = (harness: unknown): unknown => {
  if (typeof harness !== 'object' || harness === null) return harness;
  const h = harness as Record<string, unknown>;
  const map = h['escalationMap'];
  if (typeof map !== 'object' || map === null) return harness;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [from, to] of Object.entries(map)) {
    const successor = typeof to === 'string' ? unambiguousRetiredSuccessor(to) : undefined;
    if (successor !== undefined) changed = true;
    next[from] = successor ?? to;
  }
  return changed ? { ...h, escalationMap: next } : harness;
};

const healHarness = (harness: unknown): unknown => remapRetiredEscalationTargets(healHarnessCrossKnobs(harness));

/** Skill names (`ralphctl-*`) to subtract from a flow's bundled defaults; validity is checked at launch. */
const FlowSkillsRowSchema = z.object({
  disabled: z.array(z.string().trim().min(1, 'skill name must be a non-empty trimmed string')).readonly(),
});

/**
 * Durable per-flow skills opt-OUT (opt-in is filesystem-based, `<appRoot>/skills/<flow>/`). Launch
 * precedence: per-run override > this > registry default. Keys are explicit so a stray flow key is
 * stripped rather than failing the parse.
 */
const AiSkillsSchema = z.object({
  refine: FlowSkillsRowSchema.optional(),
  plan: FlowSkillsRowSchema.optional(),
  implement: FlowSkillsRowSchema.optional(),
  readiness: FlowSkillsRowSchema.optional(),
  ideate: FlowSkillsRowSchema.optional(),
  createPr: FlowSkillsRowSchema.optional(),
});

/** Per-flow AI rows, independent of each other; `effort` is the default for rows that omit their own. */
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
    skills: AiSkillsSchema.optional(),
  })
);

export const SettingsSchema = z.object({
  /** Absent in the first format; migrations run before this schema sees a file. */
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION).default(CURRENT_SCHEMA_VERSION),
  ai: AiSettingsSchema,
  harness: z.preprocess(
    healHarness,
    z
      .object({
        /** Generator–evaluator turns budgeted per `Attempt`. */
        maxTurns: z.number().int().min(1).max(10),
        /** Default cap on attempts per task before it blocks. */
        maxAttempts: z.number().int().min(1).max(10),
        /** Adapter-side retries on `RateLimitError` before surfacing the failure. */
        rateLimitRetries: z.number().int().min(0).max(10),
        /** Stdio silence (ms) before the idle watchdog SIGTERMs a wedged headless AI child (1 min – 1 h). */
        idleWatchdogMs: z.number().int().min(60_000).max(3_600_000).default(300_000),
        /** Consecutive stalled evaluator turns before a `plateau` exit; see `plateau-detection.ts`. */
        plateauThreshold: z.number().int().min(2).max(5).default(3),
        /**
         * Corrective in-round nudges on a correctable `signals.json` contract failure before
         * self-blocking. Capped tighter than the loop budgets: each nudge is a full spawn INSIDE one
         * round, consuming neither `maxTurns` nor `maxAttempts`.
         */
        correctiveRetries: z.number().int().min(1).max(5).default(2),
        /**
         * Gates ALL failure-driven escalation (plateau and budget-exhausted climb the ladder,
         * malformed retries on the same model) — the name predates that and is kept for compatibility.
         */
        escalateOnPlateau: z.boolean().default(true),
        /** Model → stronger model, merged over the generator provider's built-in ladder (user keys win). */
        escalationMap: z.record(z.string(), z.string()).default({}),
        /**
         * Skip a launch's first pre-task verify when this launch's setup just succeeded on a clean
         * tree. Only sound when the setup script actually VERIFIES the tree: an install-only setup
         * would hide a broken baseline and blame the AI for it.
         */
        skipPreVerifyOnFreshSetup: z.boolean().default(false),
        /**
         * Top-of-ladder best-of-N rung: `2`-`4` candidates, once per task; `0` disables. The granted
         * attempt spawns N generator sessions — the economic presets pin `0`.
         */
        bestOfNCandidates: z.union([z.literal(0), z.number().int().min(2).max(4)]).optional(),
      })
      .superRefine((harness, ctx) => {
        // Backstop for direct construction (persisted files are healed above): plateau history resets
        // per attempt, so with maxTurns < plateauThreshold the window never fills and escalation is
        // unreachable.
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
    /** Above 5, fold-queue contention, provider rate limits and worktree churn outweigh the gain. */
    maxParallelTasks: z.number().int().min(1).max(5),
  }),
  ui: z
    .object({
      notifications: z
        .object({
          /** Master switch for terminal bell + OS notifications; read per event, so a toggle applies at once. */
          enabled: z.boolean().default(true),
        })
        .default({ enabled: true }),
    })
    .default({ notifications: { enabled: true } }),
});

export type AiSettings = z.infer<typeof AiSettingsSchema>;
/** Discriminated row type — one entry per flow under `settings.ai.<flow>`. */
export type AiFlowSettings = z.infer<typeof FlowRowSchema>;
export type AiImplementSettings = z.infer<typeof AiImplementSchema>;
export type AiImplementRole = 'generator' | 'evaluator';
export type AiAgentBindings = z.infer<typeof AiAgentBindingsSchema>;

export const primaryAgentBinding = (agents: AiAgentBindings | undefined, role: AiImplementRole): string | undefined =>
  agents?.[role];
export type AiSkillsSettings = z.infer<typeof AiSkillsSchema>;
export type Settings = z.infer<typeof SettingsSchema>;

/** The one row single-session consumers read for `flow`; for `implement` that is the generator. */
export const primaryFlowRow = (ai: AiSettings, flow: FlowId): AiFlowSettings => {
  if (flow === 'implement') return ai.implement.generator;
  return ai[flow];
};

/** Unique providers across every row (both implement roles), in `FLOW_IDS` order. */
export const uniqueProvidersFromAi = (ai: AiSettings): readonly AiProvider[] => [
  ...new Set(
    FLOW_IDS.flatMap((flow) =>
      flow === 'implement' ? [ai.implement.generator.provider, ai.implement.evaluator.provider] : [ai[flow].provider]
    )
  ),
];

/**
 * Every {@link AiProvider} at runtime. Membership checks and "expected one of" messages MUST read
 * from here: a hand-written id list still type-checks after a provider is added.
 */
export const AI_PROVIDERS: readonly AiProvider[] = AI_PROVIDER_IDS;

export const isAiProvider = (raw: string): raw is AiProvider => (AI_PROVIDERS as readonly string[]).includes(raw);

/** Human-facing "expected one of: …" fragment, shared by every provider-validation message. */
export const AI_PROVIDERS_HINT: string = AI_PROVIDERS.join(', ');
