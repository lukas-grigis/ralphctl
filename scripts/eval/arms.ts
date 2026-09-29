import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { AiFlowSettings, AiProvider, Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { applyPreset, isPresetName } from '@src/business/settings/presets.ts';
import { resolveEffortForRow } from '@src/business/settings/resolve-effort.ts';
import { EVAL_FLOWS, type EvalFlow } from './fixture-schema.ts';
import type { ArmConfig, ResolvedRow } from './types.ts';
import { walkFiles } from './load-fixtures.ts';

/** The preset the default arm runs on: Sonnet on every row (`claude-preset-matrices.ts`, `CLAUDE_ECONOMIC`). */
export const DEFAULT_PRESET = 'claude-economic';

const PROVIDERS: readonly AiProvider[] = ['claude-code', 'github-copilot', 'openai-codex', 'opencode', 'xai-grok'];

/**
 * Which settings row each eval flow runs on — matching production so a trial uses the row the real
 * flow would: the evaluator row for both the evaluate turn and the best-of-N judge
 * (`best-of-n-judge.ts` reads `opts.evaluator`), the generator row for implement, and the
 * `readiness` row for detect-scripts (`detect-scripts` is a launch-time readiness-family flow).
 */
const ROW_OF: Readonly<
  Record<EvalFlow, { readonly flow: FlowId; readonly pick: (ai: Settings['ai']) => AiFlowSettings }>
> = {
  evaluate: { flow: 'implement', pick: (ai) => ai.implement.evaluator },
  implement: { flow: 'implement', pick: (ai) => ai.implement.generator },
  'detect-scripts': { flow: 'readiness', pick: (ai) => ai.readiness },
  'select-candidate': { flow: 'implement', pick: (ai) => ai.implement.evaluator },
};

export interface ArmOptions {
  readonly name: string;
  /** Any `PresetName`; defaults to {@link DEFAULT_PRESET}. */
  readonly preset?: string;
  /** Each provided field replaces that field on EVERY row. */
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly templatesDir?: string;
}

const invalid = (field: string, value: unknown, message: string): ValidationError =>
  new ValidationError({ field, value, message });

/** Hash of every `template.md` / partial under a templates directory — pins which prompt text an arm used. */
export const hashTemplatesDir = async (dir: string): Promise<string> => {
  const hash = createHash('sha256');
  for (const rel of await walkFiles(dir)) {
    hash.update(`${rel}\0`);
    hash.update(await fs.readFile(join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
};

/**
 * Resolve an arm's provider / model / effort per flow. Default: `applyPreset('claude-economic',
 * DEFAULT_SETTINGS)` with effort resolved per row through `resolveEffortForRow` — the same function
 * production uses. `--provider` / `--model` / `--effort` overrides replace their field on every row.
 * Model ids are NOT validated here: each provider adapter validates its own catalog at spawn time.
 */
export const buildArm = (opts: ArmOptions): Result<ArmConfig, ValidationError> => {
  const presetName = opts.preset ?? DEFAULT_PRESET;
  if (!isPresetName(presetName)) return Result.error(invalid('preset', presetName, `unknown preset '${presetName}'`));
  if (opts.provider !== undefined && !(PROVIDERS as readonly string[]).includes(opts.provider)) {
    return Result.error(
      invalid('provider', opts.provider, `unknown provider '${opts.provider}' (one of ${PROVIDERS.join(', ')})`)
    );
  }
  const settings = applyPreset(presetName, DEFAULT_SETTINGS);
  const overridden = opts.provider !== undefined || opts.model !== undefined || opts.effort !== undefined;

  const rows = {} as Record<EvalFlow, ResolvedRow>;
  for (const flow of EVAL_FLOWS) {
    const { flow: settingsFlow, pick } = ROW_OF[flow];
    const base = pick(settings.ai);
    const provider = (opts.provider as AiProvider | undefined) ?? base.provider;
    const withOverrides = {
      ...base,
      provider,
      model: opts.model ?? base.model,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    } as AiFlowSettings;
    const effort = resolveEffortForRow(withOverrides, settings.ai.effort, settingsFlow);
    rows[flow] = { provider, model: withOverrides.model, ...(effort !== undefined ? { effort } : {}) };
  }
  return Result.ok({
    name: opts.name,
    label: overridden ? `${presetName} + override` : presetName,
    rows,
    ...(opts.templatesDir !== undefined ? { templatesDir: opts.templatesDir } : {}),
  });
};
