import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, type AiProvider, SettingsSchema, type Settings } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS, defaultAiSettingsForProvider } from '@src/business/settings/defaults.ts';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';
import { applyPreset, isPresetName, PRESET_NAMES, type PresetName } from '@src/business/settings/presets.ts';
import { isClaudeModel } from '@src/domain/value/settings-models/claude.ts';
import { isCodexModel } from '@src/domain/value/settings-models/codex.ts';
import { isOpencodeModel } from '@src/domain/value/settings-models/opencode.ts';
import { isCopilotModel } from '@src/domain/value/settings-models/copilot.ts';
import { isGrokModel } from '@src/domain/value/settings-models/grok.ts';
import { mergeEscalationMap } from '@src/business/task/escalation-map.ts';

/** The exact 26-preset order — mixed first within each family; OpenCode stays standard-only. */
const EXPECTED_PRESET_ORDER: readonly PresetName[] = [
  'mixed',
  'claude-only',
  'copilot-only',
  'codex-only',
  'opencode-only',
  'grok-only',
  'mixed-economic',
  'claude-economic',
  'copilot-economic',
  'codex-economic',
  'grok-economic',
  'mixed-strong-gate',
  'claude-strong-gate',
  'copilot-strong-gate',
  'codex-strong-gate',
  'grok-strong-gate',
  'mixed-fast',
  'claude-fast',
  'copilot-fast',
  'codex-fast',
  'grok-fast',
  'mixed-frontier',
  'claude-frontier',
  'copilot-frontier',
  'codex-frontier',
  'grok-frontier',
];

const ECONOMIC_PRESETS: readonly PresetName[] = [
  'mixed-economic',
  'claude-economic',
  'copilot-economic',
  'codex-economic',
  'grok-economic',
];

/** The fast presets — the only family with escalateOnPlateau stamped OFF. */
const FAST_PRESETS: readonly PresetName[] = ['mixed-fast', 'claude-fast', 'copilot-fast', 'codex-fast', 'grok-fast'];

/** Strong-gate presets intentionally split generator and evaluator onto different models. */
const STRONG_GATE_PRESETS: readonly PresetName[] = [
  'mixed-strong-gate',
  'claude-strong-gate',
  'copilot-strong-gate',
  'codex-strong-gate',
  'grok-strong-gate',
];

/**
 * The presets that intentionally route implement.generator and implement.evaluator to DIFFERENT
 * providers — a Claude author graded by a Codex critic, mirroring the cross-provider split shipped
 * in DEFAULT_SETTINGS. `mixed-economic` joined them when its critic moved to `gpt-6-luna` at
 * `xhigh` (an independent second opinion at near-zero cost). Every other preset keeps both roles
 * on one provider (the strong-gate family splits by tier, not by provider).
 */
const CROSS_PROVIDER_IMPLEMENT_PRESETS: readonly PresetName[] = ['mixed', 'mixed-economic', 'mixed-frontier'];

/** The only presets allowed to reference a vendor's premium tier above the flagship. */
const FRONTIER_PRESETS: readonly PresetName[] = [
  'mixed-frontier',
  'claude-frontier',
  'copilot-frontier',
  'codex-frontier',
  'grok-frontier',
];

type Row = readonly [provider: AiProvider, model: string, effort: string];
interface Matrix {
  readonly effort: string;
  readonly refine: Row;
  readonly plan: Row;
  readonly generator: Row;
  readonly evaluator: Row;
  readonly readiness: Row;
  readonly ideate: Row;
  readonly createPr: Row;
}

const C = 'claude-code';
const P = 'github-copilot';
const X = 'openai-codex';
const G = 'xai-grok';
const S = 'claude-sonnet-5';
const O = 'claude-opus-5-5';
const F = 'claude-fable-5-1';
const CS = 'claude-sonnet-5';
const CO = 'claude-opus-4.8';
const L = 'gpt-5.6-luna';
const LUNA = 'gpt-6-luna';
const SOL = 'gpt-6-sol';
const ASTRA = 'gpt-6-astra';

/**
 * The full shipped matrix of every preset except `opencode-only` (which carries no effort): the
 * exact provider / model / effort of every row. Every row pins an effort — nothing may fall back
 * to the preset's global, let alone the AI CLI's own default (Opus 5.5's is only `medium`).
 */
const EXPECTED_MATRICES: Readonly<Record<Exclude<PresetName, 'opencode-only'>, Matrix>> = {
  'claude-only': {
    effort: 'high',
    refine: [C, S, 'medium'],
    plan: [C, O, 'xhigh'],
    generator: [C, O, 'xhigh'],
    evaluator: [C, O, 'xhigh'],
    readiness: [C, S, 'medium'],
    ideate: [C, O, 'high'],
    createPr: [C, S, 'low'],
  },
  'claude-economic': {
    effort: 'high',
    refine: [C, S, 'low'],
    plan: [C, S, 'high'],
    generator: [C, S, 'high'],
    evaluator: [C, S, 'high'],
    readiness: [C, S, 'low'],
    ideate: [C, S, 'medium'],
    createPr: [C, S, 'low'],
  },
  'claude-strong-gate': {
    effort: 'high',
    refine: [C, S, 'medium'],
    plan: [C, O, 'xhigh'],
    generator: [C, S, 'high'],
    evaluator: [C, O, 'xhigh'],
    readiness: [C, S, 'low'],
    ideate: [C, S, 'high'],
    createPr: [C, S, 'low'],
  },
  'claude-fast': {
    effort: 'low',
    refine: [C, S, 'low'],
    plan: [C, S, 'low'],
    generator: [C, S, 'low'],
    evaluator: [C, S, 'low'],
    readiness: [C, S, 'low'],
    ideate: [C, S, 'low'],
    createPr: [C, S, 'low'],
  },
  'claude-frontier': {
    effort: 'max',
    refine: [C, O, 'high'],
    plan: [C, F, 'max'],
    generator: [C, F, 'max'],
    evaluator: [C, F, 'max'],
    readiness: [C, O, 'high'],
    ideate: [C, F, 'high'],
    createPr: [C, O, 'medium'],
  },
  'codex-only': {
    effort: 'high',
    refine: [X, LUNA, 'high'],
    plan: [X, SOL, 'xhigh'],
    generator: [X, SOL, 'xhigh'],
    evaluator: [X, SOL, 'xhigh'],
    readiness: [X, LUNA, 'medium'],
    ideate: [X, SOL, 'high'],
    createPr: [X, LUNA, 'low'],
  },
  'codex-economic': {
    effort: 'high',
    refine: [X, LUNA, 'medium'],
    plan: [X, LUNA, 'xhigh'],
    generator: [X, LUNA, 'xhigh'],
    evaluator: [X, LUNA, 'xhigh'],
    readiness: [X, LUNA, 'low'],
    ideate: [X, LUNA, 'high'],
    createPr: [X, LUNA, 'low'],
  },
  'codex-strong-gate': {
    effort: 'high',
    refine: [X, LUNA, 'medium'],
    plan: [X, SOL, 'xhigh'],
    generator: [X, LUNA, 'xhigh'],
    evaluator: [X, SOL, 'xhigh'],
    readiness: [X, LUNA, 'medium'],
    ideate: [X, SOL, 'high'],
    createPr: [X, LUNA, 'low'],
  },
  'codex-fast': {
    effort: 'low',
    refine: [X, LUNA, 'low'],
    plan: [X, LUNA, 'low'],
    generator: [X, LUNA, 'low'],
    evaluator: [X, LUNA, 'low'],
    readiness: [X, LUNA, 'low'],
    ideate: [X, LUNA, 'low'],
    createPr: [X, LUNA, 'low'],
  },
  'codex-frontier': {
    effort: 'max',
    refine: [X, SOL, 'high'],
    plan: [X, ASTRA, 'max'],
    generator: [X, ASTRA, 'max'],
    evaluator: [X, ASTRA, 'max'],
    readiness: [X, SOL, 'high'],
    ideate: [X, ASTRA, 'high'],
    createPr: [X, SOL, 'medium'],
  },
  'copilot-only': {
    effort: 'high',
    refine: [P, CS, 'medium'],
    plan: [P, CO, 'xhigh'],
    generator: [P, CO, 'xhigh'],
    evaluator: [P, CO, 'xhigh'],
    readiness: [P, L, 'medium'],
    ideate: [P, CO, 'high'],
    createPr: [P, L, 'low'],
  },
  'copilot-economic': {
    effort: 'high',
    refine: [P, L, 'medium'],
    plan: [P, CS, 'high'],
    generator: [P, CS, 'high'],
    evaluator: [P, CS, 'high'],
    readiness: [P, L, 'medium'],
    ideate: [P, CS, 'medium'],
    createPr: [P, L, 'low'],
  },
  'copilot-strong-gate': {
    effort: 'high',
    refine: [P, CS, 'medium'],
    plan: [P, CO, 'xhigh'],
    generator: [P, CS, 'high'],
    evaluator: [P, CO, 'xhigh'],
    readiness: [P, L, 'medium'],
    ideate: [P, CS, 'high'],
    createPr: [P, L, 'low'],
  },
  'copilot-fast': {
    effort: 'low',
    refine: [P, L, 'low'],
    plan: [P, CS, 'low'],
    generator: [P, CS, 'low'],
    evaluator: [P, CS, 'low'],
    readiness: [P, L, 'low'],
    ideate: [P, L, 'low'],
    createPr: [P, L, 'low'],
  },
  'copilot-frontier': {
    effort: 'max',
    refine: [P, CO, 'high'],
    plan: [P, CO, 'max'],
    generator: [P, CO, 'max'],
    evaluator: [P, CO, 'max'],
    readiness: [P, CO, 'high'],
    ideate: [P, CO, 'high'],
    createPr: [P, CO, 'medium'],
  },
  'grok-only': {
    effort: 'high',
    refine: [G, 'grok-4.6', 'medium'],
    plan: [G, 'grok-4.7', 'xhigh'],
    generator: [G, 'grok-4.7', 'xhigh'],
    evaluator: [G, 'grok-4.7', 'xhigh'],
    readiness: [G, 'grok-4.5', 'medium'],
    ideate: [G, 'grok-4.7', 'high'],
    createPr: [G, 'grok-4.5', 'low'],
  },
  'grok-economic': {
    effort: 'high',
    refine: [G, 'grok-4.5', 'medium'],
    plan: [G, 'grok-4.6', 'high'],
    generator: [G, 'grok-4.6', 'high'],
    evaluator: [G, 'grok-4.6', 'high'],
    readiness: [G, 'grok-4.5', 'medium'],
    ideate: [G, 'grok-4.6', 'medium'],
    createPr: [G, 'grok-4.5', 'low'],
  },
  'grok-strong-gate': {
    effort: 'high',
    refine: [G, 'grok-4.5', 'medium'],
    plan: [G, 'grok-4.7', 'xhigh'],
    generator: [G, 'grok-4.6', 'high'],
    evaluator: [G, 'grok-4.7', 'xhigh'],
    readiness: [G, 'grok-4.5', 'medium'],
    ideate: [G, 'grok-4.7', 'high'],
    createPr: [G, 'grok-4.5', 'low'],
  },
  'grok-fast': {
    effort: 'low',
    refine: [G, 'grok-4.5', 'low'],
    plan: [G, 'grok-4.5', 'low'],
    generator: [G, 'grok-4.5', 'low'],
    evaluator: [G, 'grok-4.5', 'low'],
    readiness: [G, 'grok-4.5', 'low'],
    ideate: [G, 'grok-4.5', 'low'],
    createPr: [G, 'grok-4.5', 'low'],
  },
  'grok-frontier': {
    effort: 'max',
    refine: [G, 'grok-4.7', 'high'],
    plan: [G, 'grok-4.7', 'max'],
    generator: [G, 'grok-4.7', 'max'],
    evaluator: [G, 'grok-4.7', 'max'],
    readiness: [G, 'grok-4.7', 'high'],
    ideate: [G, 'grok-4.7', 'high'],
    createPr: [G, 'grok-4.7', 'medium'],
  },
  mixed: {
    effort: 'high',
    refine: [X, LUNA, 'high'],
    plan: [C, O, 'xhigh'],
    generator: [C, O, 'xhigh'],
    evaluator: [X, SOL, 'xhigh'],
    readiness: [P, L, 'medium'],
    ideate: [C, O, 'high'],
    createPr: [X, LUNA, 'low'],
  },
  'mixed-economic': {
    effort: 'high',
    refine: [X, LUNA, 'medium'],
    plan: [P, CS, 'high'],
    generator: [C, S, 'high'],
    evaluator: [X, LUNA, 'xhigh'],
    readiness: [P, L, 'medium'],
    ideate: [C, S, 'medium'],
    createPr: [X, LUNA, 'low'],
  },
  'mixed-strong-gate': {
    effort: 'high',
    refine: [X, LUNA, 'medium'],
    plan: [C, O, 'xhigh'],
    generator: [C, S, 'high'],
    evaluator: [C, O, 'xhigh'],
    readiness: [P, L, 'medium'],
    ideate: [C, S, 'high'],
    createPr: [X, LUNA, 'low'],
  },
  'mixed-fast': {
    effort: 'low',
    refine: [X, LUNA, 'low'],
    plan: [P, CS, 'low'],
    generator: [C, S, 'low'],
    evaluator: [C, S, 'low'],
    readiness: [P, L, 'low'],
    ideate: [C, S, 'low'],
    createPr: [X, LUNA, 'low'],
  },
  'mixed-frontier': {
    effort: 'max',
    refine: [X, SOL, 'high'],
    plan: [C, F, 'max'],
    generator: [C, F, 'max'],
    evaluator: [X, ASTRA, 'max'],
    readiness: [C, O, 'high'],
    ideate: [C, F, 'high'],
    createPr: [X, SOL, 'medium'],
  },
};

/** Every row of an applied preset, labelled by flow (implement split into its two roles). */
const rowsOf = (settings: Settings): ReadonlyArray<[string, Settings['ai']['refine']]> => [
  ['refine', settings.ai.refine],
  ['plan', settings.ai.plan],
  ['generator', settings.ai.implement.generator],
  ['evaluator', settings.ai.implement.evaluator],
  ['readiness', settings.ai.readiness],
  ['ideate', settings.ai.ideate],
  ['createPr', settings.ai.createPr],
];

/** Each economic preset and the standard preset whose implement flagship it should climb to. */
const ECONOMIC_TO_STANDARD: Readonly<Record<string, PresetName>> = {
  'mixed-economic': 'mixed',
  'claude-economic': 'claude-only',
  'copilot-economic': 'copilot-only',
  'codex-economic': 'codex-only',
  'grok-economic': 'grok-only',
};

/** Walk the (acyclic) default ladder from `start` to its terminal rung. */
const climbToLadderTop = (map: Readonly<Record<string, string>>, start: string): readonly string[] => {
  const path: string[] = [start];
  const seen = new Set<string>([start]);
  let cur = start;
  while (map[cur] !== undefined && map[cur] !== cur && !seen.has(map[cur]!)) {
    cur = map[cur]!;
    seen.add(cur);
    path.push(cur);
  }
  return path;
};

const modelGuardFor = (provider: AiProvider): ((s: string) => boolean) => {
  switch (provider) {
    case 'claude-code':
      return isClaudeModel;
    case 'github-copilot':
      return isCopilotModel;
    case 'openai-codex':
      return isCodexModel;
    // Preset rows are ids ralphctl itself ships, so they must stay in lockstep with
    // OPENCODE_MODELS — the permissive `provider/model` shape check belongs at the adapter
    // boundary, where authenticated upstream ids outside our catalog must still pass.
    case 'opencode':
      return isOpencodeModel;
    case 'xai-grok':
      return isGrokModel;
  }
};

describe('presets', () => {
  it('exposes all twenty-six preset names in the canonical five-family order', () => {
    expect([...PRESET_NAMES]).toEqual([...EXPECTED_PRESET_ORDER]);
    expect(PRESET_NAMES).toHaveLength(26);
  });

  it('includes each economic preset in PRESET_NAMES', () => {
    for (const preset of ECONOMIC_PRESETS) {
      expect(PRESET_NAMES).toContain(preset);
    }
  });

  it('every model referenced by every preset is a member of its provider catalog', () => {
    for (const preset of PRESET_NAMES) {
      const out = applyPreset(preset, DEFAULT_SETTINGS);
      for (const flow of FLOW_IDS) {
        const rows = flow === 'implement' ? [out.ai.implement.generator, out.ai.implement.evaluator] : [out.ai[flow]];
        for (const row of rows) {
          const guard = modelGuardFor(row.provider);
          expect(guard(row.model), `${preset}/${flow}: ${row.provider} → ${row.model}`).toBe(true);
        }
      }
    }
  });

  // Sibling of the preset check above, for the OTHER table of harness-authored model ids.
  // `defaultAiSettingsForProvider` feeds the welcome flow and `settings-set-provider`, so an
  // off-catalog id here ships a first-run config the adapter would reject. defaults.ts was
  // previously unguarded even though the catalog docstring claimed otherwise.
  //
  // Scope: this asserts catalog MEMBERSHIP, not upstream health — a cataloged id that starts
  // returning 401 (as `opencode/north-mini-code-free` did) still passes. Liveness cannot be
  // unit-tested; health-probe free-tier ids by hand before shipping one as a default.
  it('every model in the per-provider defaults is a member of its provider catalog', () => {
    const providers: readonly AiProvider[] = AI_PROVIDERS;
    for (const provider of providers) {
      const ai = defaultAiSettingsForProvider(provider);
      for (const flow of FLOW_IDS) {
        const rows = flow === 'implement' ? [ai.implement.generator, ai.implement.evaluator] : [ai[flow]];
        for (const row of rows) {
          const guard = modelGuardFor(row.provider);
          expect(guard(row.model), `defaults[${provider}]/${flow}: ${row.provider} → ${row.model}`).toBe(true);
        }
      }
    }
  });

  it('every economic preset implement.generator climbs the default ladder to its standard counterpart flagship', () => {
    for (const [economic, standard] of Object.entries(ECONOMIC_TO_STANDARD)) {
      const economicOut = applyPreset(economic as PresetName, DEFAULT_SETTINGS);
      const start = economicOut.ai.implement.generator.model;
      const provider = economicOut.ai.implement.generator.provider;
      // The runtime climbs the generator provider's own ladder — never another provider's.
      const path = climbToLadderTop(mergeEscalationMap({}, provider), start);
      const top = path[path.length - 1];
      const flagship = applyPreset(standard, DEFAULT_SETTINGS).ai.implement.generator.model;
      // The economic preset must escalate to EXACTLY the model its standard sibling uses for
      // implement — never overshooting (e.g. copilot-economic climbing past copilot-only) nor
      // undershooting. This couples presets.ts to escalation-map.ts so a catalog refresh that
      // bumps one but not the other cannot pass silently.
      expect(top, `${economic} → ${standard}: climbs to ${top}, standard flagship is ${flagship}`).toBe(flagship);
      // Every rung the climb traverses must be a real catalog member for the start provider —
      // an off-catalog intermediate rung would make the adapter reject the spawn mid-escalation.
      const guard = modelGuardFor(provider);
      for (const rung of path) {
        expect(guard(rung), `${economic}: ladder rung ${rung} not in ${provider} catalog`).toBe(true);
      }
    }
  });

  it('every strong-gate generator climbs the default ladder to its own evaluator model', () => {
    // The whole strong-gate story assumes escalateOnPlateau: the cheap author must have a real
    // default-ladder rung up to the strong evaluator model, otherwise a hard task plateau-loops
    // on the cheap generator while the strong gate keeps rejecting it.
    for (const preset of STRONG_GATE_PRESETS) {
      const out = applyPreset(preset, DEFAULT_SETTINGS);
      const generator = out.ai.implement.generator;
      const path = climbToLadderTop(mergeEscalationMap({}, generator.provider), generator.model);
      expect(
        path,
        `${preset}: ${out.ai.implement.generator.model} must climb to ${out.ai.implement.evaluator.model}`
      ).toContain(out.ai.implement.evaluator.model);
    }
  });

  it('stamps the exact provider / model / effort matrix for every preset, with an explicit effort on every row', () => {
    for (const [preset, expected] of Object.entries(EXPECTED_MATRICES) as ReadonlyArray<[PresetName, Matrix]>) {
      const out = applyPreset(preset, DEFAULT_SETTINGS);
      expect(out.ai.effort, `${preset}: global effort`).toBe(expected.effort);
      for (const [flow, row] of rowsOf(out)) {
        const want = expected[flow as keyof Omit<Matrix, 'effort'>];
        expect([row.provider, row.model, row.effort], `${preset}/${flow}`).toEqual([...want]);
      }
    }
    // The table covers every preset but opencode-only, so a new preset cannot skip it.
    expect(Object.keys(EXPECTED_MATRICES).sort()).toEqual(PRESET_NAMES.filter((p) => p !== 'opencode-only').sort());
  });

  it('opencode-only leaves effort unset on every row — --variant values come from the upstream provider', () => {
    const out = applyPreset('opencode-only', DEFAULT_SETTINGS);
    expect(out.ai.effort).toBeUndefined();
    for (const [flow, row] of rowsOf(out)) {
      expect(row.provider, flow).toBe('opencode');
      expect(row.effort, flow).toBeUndefined();
    }
  });

  it('premium tiers (Fable 5.1, gpt-6-astra) appear only in the frontier family and are never a default-ladder rung', () => {
    // Fable 5.1 is Anthropic's flagship above Opus and astra is Codex's premium tier (2.5x Opus 5.5
    // and 5x gpt-6-sol respectively). The frontier family is the "no cost ceiling" preset, so it
    // runs them on its deep flows; every other family, the provider defaults, and the built-in
    // escalation ladders stay off them — an operator reaches them only by a deliberate pick.
    const premium = (model: string): boolean => model.startsWith('claude-fable') || model === ASTRA;
    for (const preset of PRESET_NAMES) {
      for (const [flow, row] of rowsOf(applyPreset(preset, DEFAULT_SETTINGS))) {
        if (!FRONTIER_PRESETS.includes(preset)) {
          expect(premium(row.model), `${preset}/${flow}: ${row.model}`).toBe(false);
        }
        // Only the current Fable, never the superseded base or a `[1m]` variant.
        if (row.model.startsWith('claude-fable')) expect(row.model, `${preset}/${flow}`).toBe(F);
      }
    }
    for (const provider of AI_PROVIDERS) {
      for (const [flow, row] of rowsOf({ ...DEFAULT_SETTINGS, ai: defaultAiSettingsForProvider(provider) })) {
        expect(premium(row.model), `defaults[${provider}]/${flow}: ${row.model}`).toBe(false);
      }
      for (const [from, to] of Object.entries(mergeEscalationMap({}, provider))) {
        expect(premium(from), `${provider}: ladder rung from '${from}'`).toBe(false);
        expect(premium(to), `${provider}: ladder rung '${from}' → '${to}'`).toBe(false);
      }
    }
  });

  it('no preset row references a retiring cheap tier', () => {
    // `gpt-5.4-mini` left Codex on 2026-08-31 and `gpt-5-mini` is the generation below it; the
    // cheap tier is now luna (`gpt-6-luna` on Codex, `gpt-5.6-luna` on Copilot). `gpt-5.5` leaves
    // Codex on 2026-10-14. `claude-haiku-4-5` has an Anthropic retirement horizon (not before
    // 2026-10-15) with no Haiku 5 successor, so every cheap-flow claude slot sits on
    // `claude-sonnet-5` at `low` effort instead. Ids that remain catalogued stay pinnable until the
    // shutoff — what this fences is the curated matrices shipping a row that stops spawning on a
    // known date.
    const retiring = new Set(['gpt-5.4-mini', 'gpt-5-mini', 'claude-haiku-4-5', 'gpt-5.5']);
    for (const preset of PRESET_NAMES) {
      const out = applyPreset(preset, DEFAULT_SETTINGS);
      for (const flow of FLOW_IDS) {
        const rows = flow === 'implement' ? [out.ai.implement.generator, out.ai.implement.evaluator] : [out.ai[flow]];
        for (const row of rows) {
          expect(retiring.has(row.model), `${preset}/${flow}: ${row.model}`).toBe(false);
        }
      }
    }
  });

  it('every claude family routes readiness to Sonnet 5 — the cheap families separate by EFFORT, not by model', () => {
    // Haiku 4.5 is on a retirement horizon with no successor, so the cheap claude families moved
    // their light flows onto sonnet at `low` effort rather than a weaker model. The cost intent
    // survives in the effort column: standard reads a repo at `medium`, the cheap families at
    // `low`. `low` is pinned EXPLICITLY on those rows — leaving effort unset would inherit the
    // global (`high` for economic / strong-gate) and silently raise the bill.
    expect(applyPreset('claude-only', DEFAULT_SETTINGS).ai.readiness.model).toBe('claude-sonnet-5');
    expect(applyPreset('claude-only', DEFAULT_SETTINGS).ai.readiness.effort).toBe('medium');
    for (const preset of ['claude-economic', 'claude-strong-gate', 'claude-fast'] as const) {
      const out = applyPreset(preset, DEFAULT_SETTINGS);
      expect(out.ai.readiness.model, preset).toBe('claude-sonnet-5');
      expect(out.ai.readiness.effort, preset).toBe('low');
    }
  });

  it('every migrated cheap-flow row pins effort explicitly so it cannot inherit a pricier global', () => {
    // The rows that used to be haiku: refine / readiness / createPr on claude-economic and
    // claude-fast, readiness / createPr on claude-strong-gate, ideate on mixed-fast + claude-fast.
    const cheapClaudeRows: ReadonlyArray<[PresetName, 'refine' | 'readiness' | 'ideate' | 'createPr']> = [
      ['claude-economic', 'refine'],
      ['claude-economic', 'readiness'],
      ['claude-economic', 'createPr'],
      ['claude-strong-gate', 'readiness'],
      ['claude-strong-gate', 'createPr'],
      ['mixed-fast', 'ideate'],
      ['claude-fast', 'refine'],
      ['claude-fast', 'readiness'],
      ['claude-fast', 'ideate'],
      ['claude-fast', 'createPr'],
    ];
    for (const [preset, flow] of cheapClaudeRows) {
      const row = applyPreset(preset, DEFAULT_SETTINGS).ai[flow];
      expect(row.provider, `${preset}/${flow}`).toBe('claude-code');
      expect(row.model, `${preset}/${flow}`).toBe('claude-sonnet-5');
      expect(row.effort, `${preset}/${flow}`).toBe('low');
    }
  });

  it('isPresetName accepts all twenty-six preset names and rejects garbage', () => {
    for (const preset of EXPECTED_PRESET_ORDER) {
      expect(isPresetName(preset), preset).toBe(true);
    }
    expect(isPresetName('not-a-preset')).toBe(false);
    expect(isPresetName('')).toBe(false);
    expect(isPresetName('mixed-turbo')).toBe(false);
    expect(isPresetName('claude')).toBe(false);
  });

  describe('applyPreset', () => {
    const sentinel: Settings = {
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, maxTurns: 9, maxAttempts: 7, escalationMap: { 'foo-1': 'foo-2' } },
      logging: { level: 'debug' },
      concurrency: { maxParallelTasks: 3 },
      ui: { notifications: { enabled: false } },
      scm: { postRefinementComment: true },
    };

    for (const preset of PRESET_NAMES) {
      it(`'${preset}' stamps an ai section that round-trips through SettingsSchema`, () => {
        const out = applyPreset(preset, DEFAULT_SETTINGS);
        const parsed = SettingsSchema.safeParse(out);
        // A clean parse catches any invalid per-row effort (e.g. xhigh/max on a codex row) or
        // off-catalog model id the matrix might smuggle in.
        expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
      });

      it(`'${preset}' preserves logging / concurrency / ui / scm / schemaVersion and the rest of harness from current`, () => {
        const out = applyPreset(preset, sentinel);
        expect(out.logging).toEqual(sentinel.logging);
        expect(out.concurrency).toEqual(sentinel.concurrency);
        expect(out.ui).toEqual(sentinel.ui);
        expect(out.scm).toEqual(sentinel.scm);
        expect(out.schemaVersion).toEqual(sentinel.schemaVersion);
        // Every harness key EXCEPT escalateOnPlateau is preserved verbatim.
        expect(out.harness.maxTurns).toBe(sentinel.harness.maxTurns);
        expect(out.harness.maxAttempts).toBe(sentinel.harness.maxAttempts);
        expect(out.harness.escalationMap).toEqual(sentinel.harness.escalationMap);
        expect(out.harness.plateauThreshold).toBe(sentinel.harness.plateauThreshold);
        expect(out.harness.rateLimitRetries).toBe(sentinel.harness.rateLimitRetries);
        expect(out.harness.idleWatchdogMs).toBe(sentinel.harness.idleWatchdogMs);
        expect(out.harness.skipPreVerifyOnFreshSetup).toBe(sentinel.harness.skipPreVerifyOnFreshSetup);
      });

      it(`'${preset}' stamps harness.escalateOnPlateau (off for fast, on otherwise)`, () => {
        const expected = !FAST_PRESETS.includes(preset);
        // Flip the sentinel's flag to the opposite of expected so we prove applyPreset wrote it,
        // not that it merely inherited a matching value from current.
        const current: Settings = {
          ...sentinel,
          harness: { ...sentinel.harness, escalateOnPlateau: !expected },
        };
        const out = applyPreset(preset, current);
        expect(out.harness.escalateOnPlateau, preset).toBe(expected);
      });

      it(`'${preset}' pins harness.bestOfNCandidates to 0 for the economic family and leaves it alone elsewhere`, () => {
        // The shipped default is 2, so the economic family's cost opt-out has to be an explicit
        // stamp, not an inherited zero. Seed a non-default 4 so the assertion distinguishes
        // "overwritten with 0" from "preserved" for every other family.
        const current: Settings = { ...sentinel, harness: { ...sentinel.harness, bestOfNCandidates: 4 } };
        const out = applyPreset(preset, current);
        expect(out.harness.bestOfNCandidates, preset).toBe(ECONOMIC_PRESETS.includes(preset) ? 0 : 4);
      });

      it(`'${preset}' stamps a row for every flow id`, () => {
        const out = applyPreset(preset, DEFAULT_SETTINGS);
        for (const flow of FLOW_IDS) {
          expect(out.ai[flow]).toBeDefined();
          if (flow === 'implement') {
            for (const role of ['generator', 'evaluator'] as const) {
              expect(out.ai.implement[role].provider).toMatch(
                /^(claude-code|github-copilot|openai-codex|opencode|xai-grok)$/
              );
              expect(out.ai.implement[role].model.length).toBeGreaterThan(0);
            }
            continue;
          }
          expect(out.ai[flow].provider).toMatch(/^(claude-code|github-copilot|openai-codex|opencode|xai-grok)$/);
          expect(out.ai[flow].model.length).toBeGreaterThan(0);
        }
      });

      it(`'${preset}' stamps implement.generator and implement.evaluator per its family's split rule`, () => {
        const out = applyPreset(preset, DEFAULT_SETTINGS);
        // Most presets keep generator + evaluator on the SAME provider AND the same model. Two
        // deliberate exceptions:
        //   strong-gate — same provider, cheap generator vs permanently-strong evaluator (tier split)
        //   mixed / mixed-frontier — same tier, Claude author vs Codex critic (provider split), so
        //                            the gate is a genuinely independent second opinion
        // Both are asserted explicitly in their own blocks below.
        if (CROSS_PROVIDER_IMPLEMENT_PRESETS.includes(preset)) {
          expect(out.ai.implement.generator.provider).not.toBe(out.ai.implement.evaluator.provider);
          return;
        }
        expect(out.ai.implement.generator.provider).toBe(out.ai.implement.evaluator.provider);
        if (!STRONG_GATE_PRESETS.includes(preset)) {
          expect(out.ai.implement.generator.model).toBe(out.ai.implement.evaluator.model);
        }
      });
    }

    it("'mixed' grades its Claude generator with the same Codex critic DEFAULT_SETTINGS ships", () => {
      // An independent critic beats one that shares the author's blind spots — the shipped default
      // and the flagship mixed preset make the same split, so they must name the same evaluator.
      const out = applyPreset('mixed', DEFAULT_SETTINGS);
      expect(out.ai.implement.generator).toMatchObject({ provider: 'claude-code', model: O });
      expect(out.ai.implement.evaluator.provider).toBe(DEFAULT_SETTINGS.ai.implement.evaluator.provider);
      expect(out.ai.implement.evaluator.model).toBe(DEFAULT_SETTINGS.ai.implement.evaluator.model);
    });

    describe('fast family does not use haiku / nano for implement', () => {
      it('keeps every fast implement row on a code-capable tier (no haiku, no nano)', () => {
        for (const preset of FAST_PRESETS) {
          const out = applyPreset(preset, DEFAULT_SETTINGS);
          for (const role of ['generator', 'evaluator'] as const) {
            const model = out.ai.implement[role].model;
            expect(model.includes('haiku'), `${preset}/${role}: ${model}`).toBe(false);
            expect(model.includes('nano'), `${preset}/${role}: ${model}`).toBe(false);
          }
        }
      });
    });

    it('grok-4.7-build-fast stays opt-in — no preset row references it', () => {
      for (const preset of PRESET_NAMES) {
        const out = applyPreset(preset, DEFAULT_SETTINGS);
        for (const flow of FLOW_IDS) {
          const rows = flow === 'implement' ? [out.ai.implement.generator, out.ai.implement.evaluator] : [out.ai[flow]];
          for (const row of rows) {
            expect(row.model, `${preset}/${flow}`).not.toBe('grok-4.7-build-fast');
          }
        }
      }
    });

    it('leaves no preset identity behind — a subsequent manual edit sticks', () => {
      const applied = applyPreset('claude-only', DEFAULT_SETTINGS);
      const edited: Settings = {
        ...applied,
        ai: {
          ...applied.ai,
          implement: {
            ...applied.ai.implement,
            generator: { ...applied.ai.implement.generator, model: 'claude-haiku-4-5' },
          },
        } as Settings['ai'],
      };
      // Re-parse to confirm no hidden "preset" residue clobbers the edit.
      const parsed = SettingsSchema.safeParse(edited);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.ai.implement.generator.model).toBe('claude-haiku-4-5');
      }
    });
  });
});
