import type { AiFlowSettings, AiProvider, AiSettings } from '@src/domain/entity/settings.ts';
import { FLOW_IDS, type FlowId } from '@src/domain/value/flow-id.ts';
import {
  COPILOT_LUNA,
  COPILOT_OPUS,
  COPILOT_SONNET,
  FABLE,
  GPT_6_1_SOL,
  GPT_6_ASTRA,
  GPT_6_LUNA,
  GROK_CHEAP,
  GROK_FLAGSHIP,
  GROK_MID,
  OPENCODE_BIG,
  OPENCODE_MINI,
  OPUS,
  SONNET,
} from '@src/business/settings/preset-model-ids.ts';

const CLAUDE_OPUS_5 = 'claude-opus-5';
const CLAUDE_OPUS_4_8 = 'claude-opus-4-8';
// Same undotted slug on both catalogs.
const SONNET_5 = 'claude-sonnet-5';
const GPT_6_SOL = 'gpt-6-sol';
const GPT_5_6_SOL = 'gpt-5.6-sol';

/**
 * Same-provider stand-ins for every model a preset or provider default stamps, nearest first.
 * Used when the account can't run the stamped model (plan gating, a gradual rollout, a revoked
 * model policy). Stand-ins stay at the same or a cheaper tier, except for a provider's cheapest tier
 * (`grok-4.5`), which can only step up. When no listed stand-in is available the row keeps its
 * model and the caller reports it. Effort rides along unchanged — resolution
 * narrows it to whatever the stand-in accepts (`clampEffortToModel`).
 */
export const PRESET_MODEL_FALLBACKS: Readonly<Record<AiProvider, Readonly<Record<string, readonly string[]>>>> = {
  'claude-code': {
    [FABLE]: [OPUS, CLAUDE_OPUS_5, CLAUDE_OPUS_4_8],
    [OPUS]: [CLAUDE_OPUS_5, CLAUDE_OPUS_4_8, SONNET],
    [SONNET]: [SONNET_5, 'claude-sonnet-4-6'],
  },
  'github-copilot': {
    [COPILOT_OPUS]: [COPILOT_SONNET, SONNET_5],
    [COPILOT_SONNET]: [SONNET_5],
    [COPILOT_LUNA]: ['gpt-5.6-luna'],
  },
  'openai-codex': {
    [GPT_6_ASTRA]: [GPT_6_1_SOL, GPT_6_SOL, GPT_5_6_SOL],
    [GPT_6_1_SOL]: [GPT_6_SOL, GPT_5_6_SOL],
    [GPT_6_LUNA]: ['gpt-5.6-luna'],
  },
  'xai-grok': {
    [GROK_FLAGSHIP]: [GROK_MID, GROK_CHEAP],
    [GROK_MID]: [GROK_CHEAP],
    [GROK_CHEAP]: [GROK_MID],
  },
  opencode: {
    [OPENCODE_BIG]: [OPENCODE_MINI],
    [OPENCODE_MINI]: [OPENCODE_BIG],
  },
};

/** Where a row sits: a flat flow, or one of implement's two roles. */
export interface AiRowLocation {
  readonly flow: FlowId;
  readonly role?: 'generator' | 'evaluator';
}

/** A row moved to a stand-in because the account can't run its model. */
export interface ModelSubstitution extends AiRowLocation {
  readonly provider: AiProvider;
  readonly from: string;
  readonly to: string;
}

/** A row whose model the account can't run and that has no available stand-in. */
export interface UnavailableModel extends AiRowLocation {
  readonly provider: AiProvider;
  readonly model: string;
}

export interface AdaptedAiSettings {
  readonly ai: AiSettings;
  readonly substitutions: readonly ModelSubstitution[];
  readonly unavailable: readonly UnavailableModel[];
}

/** Settings-key spelling of a row location, e.g. `ai.implement.generator` / `ai.refine`. */
export const aiRowKey = ({ flow, role }: AiRowLocation): string =>
  role === undefined ? `ai.${flow}` : `ai.${flow}.${role}`;

/**
 * Move every row whose model the account can't run onto its nearest available stand-in
 * ({@link PRESET_MODEL_FALLBACKS}). `available` holds the live answer per provider; a provider
 * missing from it is left untouched, so a probe that could not answer never rewrites anything.
 * Pure — the caller does the probing.
 */
export const adaptAiToAvailableModels = (
  ai: AiSettings,
  available: ReadonlyMap<AiProvider, ReadonlySet<string>>
): AdaptedAiSettings => {
  const substitutions: ModelSubstitution[] = [];
  const unavailable: UnavailableModel[] = [];

  const adaptRow = <R extends AiFlowSettings>(row: R, location: AiRowLocation): R => {
    const models = available.get(row.provider);
    if (models === undefined || models.has(row.model)) return row;
    const standIn = (PRESET_MODEL_FALLBACKS[row.provider][row.model] ?? []).find((m) => models.has(m));
    if (standIn === undefined) {
      unavailable.push({ ...location, provider: row.provider, model: row.model });
      return row;
    }
    substitutions.push({ ...location, provider: row.provider, from: row.model, to: standIn });
    return { ...row, model: standIn };
  };

  let next: AiSettings = ai;
  for (const flow of FLOW_IDS) {
    if (flow === 'implement') {
      next = {
        ...next,
        implement: {
          generator: adaptRow(next.implement.generator, { flow, role: 'generator' }),
          evaluator: adaptRow(next.implement.evaluator, { flow, role: 'evaluator' }),
        },
      };
    } else {
      next = { ...next, [flow]: adaptRow(next[flow], { flow }) };
    }
  }
  return { ai: next, substitutions, unavailable };
};
