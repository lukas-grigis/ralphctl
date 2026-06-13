import { describe, expect, it } from 'vitest';
import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import { SettingsSchema } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';
import { applyPreset, isPresetName, PRESET_NAMES, type PresetName } from '@src/business/settings/presets.ts';
import { isClaudeModel } from '@src/domain/value/settings-models/claude.ts';
import { isCodexModel } from '@src/domain/value/settings-models/codex.ts';
import { isCopilotModel } from '@src/domain/value/settings-models/copilot.ts';
import { mergeEscalationMap } from '@src/business/task/escalation-map.ts';

/** The exact 20-preset order — 5 families × 4 (mixed-first within each family). */
const EXPECTED_PRESET_ORDER: readonly PresetName[] = [
  'mixed',
  'claude-only',
  'copilot-only',
  'codex-only',
  'mixed-economic',
  'claude-economic',
  'copilot-economic',
  'codex-economic',
  'mixed-strong-gate',
  'claude-strong-gate',
  'copilot-strong-gate',
  'codex-strong-gate',
  'mixed-fast',
  'claude-fast',
  'copilot-fast',
  'codex-fast',
  'mixed-frontier',
  'claude-frontier',
  'copilot-frontier',
  'codex-frontier',
];

const ECONOMIC_PRESETS: readonly PresetName[] = [
  'mixed-economic',
  'claude-economic',
  'copilot-economic',
  'codex-economic',
];

/** The four fast presets — the only family with escalateOnPlateau stamped OFF. */
const FAST_PRESETS: readonly PresetName[] = ['mixed-fast', 'claude-fast', 'copilot-fast', 'codex-fast'];

/** Strong-gate presets intentionally split generator and evaluator onto different models. */
const STRONG_GATE_PRESETS: readonly PresetName[] = [
  'mixed-strong-gate',
  'claude-strong-gate',
  'copilot-strong-gate',
  'codex-strong-gate',
];

/** Each economic preset and the standard preset whose implement flagship it should climb to. */
const ECONOMIC_TO_STANDARD: Readonly<Record<string, PresetName>> = {
  'mixed-economic': 'mixed',
  'claude-economic': 'claude-only',
  'copilot-economic': 'copilot-only',
  'codex-economic': 'codex-only',
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
  }
};

describe('presets', () => {
  it('exposes all twenty preset names in the canonical five-family order', () => {
    expect([...PRESET_NAMES]).toEqual([...EXPECTED_PRESET_ORDER]);
    expect(PRESET_NAMES).toHaveLength(20);
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

  it('every economic preset implement.generator climbs the default ladder to its standard counterpart flagship', () => {
    const ladder = mergeEscalationMap({});
    for (const [economic, standard] of Object.entries(ECONOMIC_TO_STANDARD)) {
      const economicOut = applyPreset(economic as PresetName, DEFAULT_SETTINGS);
      const start = economicOut.ai.implement.generator.model;
      const provider = economicOut.ai.implement.generator.provider;
      const path = climbToLadderTop(ladder, start);
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
    const ladder = mergeEscalationMap({});
    for (const preset of STRONG_GATE_PRESETS) {
      const out = applyPreset(preset, DEFAULT_SETTINGS);
      const path = climbToLadderTop(ladder, out.ai.implement.generator.model);
      expect(
        path,
        `${preset}: ${out.ai.implement.generator.model} must climb to ${out.ai.implement.evaluator.model}`
      ).toContain(out.ai.implement.evaluator.model);
    }
  });

  it('claude-fable-5 (base + 1M variant) is in catalog but stays opt-in only — no preset row and no default ladder rung references it', () => {
    // Catalog membership is what lets a per-row pick pass the adapter boundary…
    expect(isClaudeModel('claude-fable-5')).toBe(true);
    expect(isClaudeModel('claude-fable-5[1m]')).toBe(true);
    expect(isClaudeModel('claude-opus-4-8[1m]')).toBe(true);
    // …while presets and the built-in escalation ladder deliberately do NOT reference it: the
    // catalog-top = ladder-top = preset-flagship invariant intentionally excludes the fable tier
    // until a deliberate flagship swap. Promoting it later means deleting this fence on purpose.
    // The frontier family tops out at opus for exactly this reason (fable is export-suspended).
    for (const preset of PRESET_NAMES) {
      const out = applyPreset(preset, DEFAULT_SETTINGS);
      for (const flow of FLOW_IDS) {
        const rows = flow === 'implement' ? [out.ai.implement.generator, out.ai.implement.evaluator] : [out.ai[flow]];
        for (const row of rows) {
          expect(row.model.startsWith('claude-fable'), `${preset}/${flow}: ${row.model}`).toBe(false);
        }
      }
    }
    for (const [from, to] of Object.entries(mergeEscalationMap({}))) {
      expect(from.startsWith('claude-fable'), `ladder rung from '${from}'`).toBe(false);
      expect(to.startsWith('claude-fable'), `ladder rung '${from}' → '${to}'`).toBe(false);
    }
  });

  it('codex-only no longer references the deprecated gpt-5.3-codex', () => {
    const out = applyPreset('codex-only', DEFAULT_SETTINGS);
    const models = [
      out.ai.refine.model,
      out.ai.plan.model,
      out.ai.implement.generator.model,
      out.ai.implement.evaluator.model,
      out.ai.readiness.model,
      out.ai.ideate.model,
      out.ai.createPr.model,
    ];
    expect(models).not.toContain('gpt-5.3-codex');
    expect(out.ai.implement.generator.model).toBe('gpt-5.5');
    expect(out.ai.implement.evaluator.model).toBe('gpt-5.5');
    expect(out.ai.implement.generator.effort).toBe('high');
    expect(out.ai.implement.evaluator.effort).toBe('high');
  });

  it('isPresetName accepts all twenty preset names and rejects garbage', () => {
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
      developer: { showEvaluatorFailureUI: true },
    };

    for (const preset of PRESET_NAMES) {
      it(`'${preset}' stamps an ai section that round-trips through SettingsSchema`, () => {
        const out = applyPreset(preset, DEFAULT_SETTINGS);
        const parsed = SettingsSchema.safeParse(out);
        // A clean parse catches any invalid per-row effort (e.g. xhigh/max on a codex row) or
        // off-catalog model id the matrix might smuggle in.
        expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
      });

      it(`'${preset}' preserves logging / concurrency / ui / developer / schemaVersion and the rest of harness from current`, () => {
        const out = applyPreset(preset, sentinel);
        expect(out.logging).toEqual(sentinel.logging);
        expect(out.concurrency).toEqual(sentinel.concurrency);
        expect(out.ui).toEqual(sentinel.ui);
        expect(out.developer).toEqual(sentinel.developer);
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

      it(`'${preset}' stamps a row for every flow id`, () => {
        const out = applyPreset(preset, DEFAULT_SETTINGS);
        for (const flow of FLOW_IDS) {
          expect(out.ai[flow]).toBeDefined();
          if (flow === 'implement') {
            for (const role of ['generator', 'evaluator'] as const) {
              expect(out.ai.implement[role].provider).toMatch(/^(claude-code|github-copilot|openai-codex)$/);
              expect(out.ai.implement[role].model.length).toBeGreaterThan(0);
            }
            continue;
          }
          expect(out.ai[flow].provider).toMatch(/^(claude-code|github-copilot|openai-codex)$/);
          expect(out.ai[flow].model.length).toBeGreaterThan(0);
        }
      });

      it(`'${preset}' stamps both implement.generator and implement.evaluator with the same provider`, () => {
        const out = applyPreset(preset, DEFAULT_SETTINGS);
        expect(out.ai.implement.generator.provider).toBe(out.ai.implement.evaluator.provider);
        // Every preset keeps generator + evaluator on the SAME provider. Sharing the same MODEL
        // is the norm too — EXCEPT the strong-gate family, which intentionally pairs a cheap
        // generator with a permanently-strong evaluator (asserted explicitly in its own block).
        if (!STRONG_GATE_PRESETS.includes(preset)) {
          expect(out.ai.implement.generator.model).toBe(out.ai.implement.evaluator.model);
        }
      });
    }

    it('the four fast presets stamp global ai.effort to low', () => {
      for (const preset of FAST_PRESETS) {
        const out = applyPreset(preset, DEFAULT_SETTINGS);
        expect(out.ai.effort, preset).toBe('low');
      }
    });

    it('the standard, economic and strong-gate presets stamp global ai.effort to high', () => {
      const highEffort: readonly PresetName[] = [
        'mixed',
        'claude-only',
        'copilot-only',
        'codex-only',
        ...ECONOMIC_PRESETS,
        ...STRONG_GATE_PRESETS,
      ];
      for (const preset of highEffort) {
        const out = applyPreset(preset, DEFAULT_SETTINGS);
        expect(out.ai.effort, preset).toBe('high');
      }
    });

    it('frontier presets stamp global ai.effort to max — except codex-frontier which floors to high', () => {
      expect(applyPreset('mixed-frontier', DEFAULT_SETTINGS).ai.effort).toBe('max');
      expect(applyPreset('claude-frontier', DEFAULT_SETTINGS).ai.effort).toBe('max');
      expect(applyPreset('copilot-frontier', DEFAULT_SETTINGS).ai.effort).toBe('max');
      // Codex has no max/xhigh effort rung, so the global stays high to avoid implying a max row.
      expect(applyPreset('codex-frontier', DEFAULT_SETTINGS).ai.effort).toBe('high');
    });

    describe("'mixed' preset matrix", () => {
      const out = applyPreset('mixed', DEFAULT_SETTINGS);

      it('routes refine to openai-codex, plan to github-copilot, implement to claude-code', () => {
        expect(out.ai.refine.provider).toBe('openai-codex');
        expect(out.ai.plan.provider).toBe('github-copilot');
        expect(out.ai.implement.generator.provider).toBe('claude-code');
        expect(out.ai.implement.evaluator.provider).toBe('claude-code');
        expect(out.ai.readiness.provider).toBe('github-copilot');
        expect(out.ai.ideate.provider).toBe('claude-code');
      });

      it('sets implement and plan effort to xhigh, readiness to medium, refine/ideate unset', () => {
        expect(out.ai.implement.generator.effort).toBe('xhigh');
        expect(out.ai.implement.evaluator.effort).toBe('xhigh');
        expect(out.ai.plan.effort).toBe('xhigh');
        expect(out.ai.readiness.effort).toBe('medium');
        expect(out.ai.refine.effort).toBeUndefined();
        expect(out.ai.ideate.effort).toBeUndefined();
      });
    });

    describe("'claude-strong-gate' preset matrix", () => {
      const out = applyPreset('claude-strong-gate', DEFAULT_SETTINGS);

      it('routes every flow to claude-code', () => {
        for (const flow of FLOW_IDS) {
          if (flow === 'implement') {
            expect(out.ai.implement.generator.provider).toBe('claude-code');
            expect(out.ai.implement.evaluator.provider).toBe('claude-code');
            continue;
          }
          expect(out.ai[flow].provider).toBe('claude-code');
        }
      });

      it('stamps the exact model + effort matrix', () => {
        expect(out.ai.effort).toBe('high');
        expect(out.ai.refine.model).toBe('claude-sonnet-4-6');
        expect(out.ai.refine.effort).toBeUndefined();
        expect(out.ai.plan.model).toBe('claude-opus-4-8');
        expect(out.ai.plan.effort).toBe('xhigh');
        expect(out.ai.readiness.model).toBe('claude-haiku-4-5');
        expect(out.ai.readiness.effort).toBe('medium');
        expect(out.ai.ideate.model).toBe('claude-sonnet-4-6');
        expect(out.ai.ideate.effort).toBeUndefined();
        expect(out.ai.createPr.model).toBe('claude-haiku-4-5');
      });

      it('splits a cheap sonnet generator against a strong opus evaluator (same provider, different model)', () => {
        // The novel property no other family has: generator weaker than evaluator.
        expect(out.ai.implement.generator.provider).toBe(out.ai.implement.evaluator.provider);
        expect(out.ai.implement.generator.model).toBe('claude-sonnet-4-6');
        expect(out.ai.implement.evaluator.model).toBe('claude-opus-4-8');
        expect(out.ai.implement.generator.model).not.toBe(out.ai.implement.evaluator.model);
        expect(out.ai.implement.generator.effort).toBe('high');
        expect(out.ai.implement.evaluator.effort).toBe('xhigh');
      });
    });

    describe("'codex-strong-gate' preset matrix — the narrowest gate", () => {
      const out = applyPreset('codex-strong-gate', DEFAULT_SETTINGS);

      it('pairs a gpt-5.4 author with a gpt-5.5 evaluator one rung apart', () => {
        expect(out.ai.implement.generator.provider).toBe('openai-codex');
        expect(out.ai.implement.evaluator.provider).toBe('openai-codex');
        expect(out.ai.implement.generator.model).toBe('gpt-5.4');
        expect(out.ai.implement.evaluator.model).toBe('gpt-5.5');
        // Codex never carries xhigh/max — both rows floor at high.
        expect(out.ai.implement.generator.effort).toBe('high');
        expect(out.ai.implement.evaluator.effort).toBe('high');
      });
    });

    describe("'codex-fast' preset matrix", () => {
      const out = applyPreset('codex-fast', DEFAULT_SETTINGS);

      it('leans on minimal effort for light flows and low effort for implement', () => {
        expect(out.ai.refine.effort).toBe('minimal');
        expect(out.ai.readiness.effort).toBe('minimal');
        expect(out.ai.createPr.effort).toBe('minimal');
        expect(out.ai.implement.generator.effort).toBe('low');
        expect(out.ai.implement.evaluator.effort).toBe('low');
      });

      it('uses the mini tier for implement rather than a coding-grade frontier model', () => {
        expect(out.ai.implement.generator.model).toBe('gpt-5.4-mini');
      });
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

    describe('frontier family tops out at opus / gpt-5.5 (never fable)', () => {
      it('routes implement to the provider flagship at max effort (codex floored to high)', () => {
        const cases: ReadonlyArray<[PresetName, string, 'max' | 'high']> = [
          ['mixed-frontier', 'claude-opus-4-8', 'max'],
          ['claude-frontier', 'claude-opus-4-8', 'max'],
          ['copilot-frontier', 'claude-opus-4.8', 'max'],
          ['codex-frontier', 'gpt-5.5', 'high'],
        ];
        for (const [preset, model, effort] of cases) {
          const out = applyPreset(preset, DEFAULT_SETTINGS);
          expect(out.ai.implement.generator.model, preset).toBe(model);
          expect(out.ai.implement.evaluator.model, preset).toBe(model);
          expect(out.ai.implement.generator.effort, preset).toBe(effort);
        }
      });
    });

    const providerOnlyPresets: ReadonlyArray<[PresetName, AiProvider]> = [
      ['claude-only', 'claude-code'],
      ['copilot-only', 'github-copilot'],
      ['codex-only', 'openai-codex'],
    ];

    for (const [preset, provider] of providerOnlyPresets) {
      describe(`'${preset}' preset`, () => {
        const out = applyPreset(preset, DEFAULT_SETTINGS);

        it(`routes every flow to ${provider}`, () => {
          for (const flow of FLOW_IDS) {
            if (flow === 'implement') {
              expect(out.ai.implement.generator.provider).toBe(provider);
              expect(out.ai.implement.evaluator.provider).toBe(provider);
              continue;
            }
            expect(out.ai[flow].provider).toBe(provider);
          }
        });

        it('matches the effort matrix (implement+plan xhigh / codex high, readiness medium, refine+ideate unset)', () => {
          const heavyEffort = provider === 'openai-codex' ? 'high' : 'xhigh';
          expect(out.ai.implement.generator.effort).toBe(heavyEffort);
          expect(out.ai.implement.evaluator.effort).toBe(heavyEffort);
          expect(out.ai.plan.effort).toBe(heavyEffort);
          expect(out.ai.readiness.effort).toBe('medium');
          expect(out.ai.refine.effort).toBeUndefined();
          expect(out.ai.ideate.effort).toBeUndefined();
        });
      });
    }

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
