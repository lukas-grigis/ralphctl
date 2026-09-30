import { parseArgs } from 'node:util';
import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { EVAL_FLOWS, type EvalFlow } from './fixture-schema.ts';

/** Parsed `pnpm eval …` invocation. Pure — no I/O, so every rule here is unit-tested. */

export interface CommonOptions {
  readonly flows: readonly EvalFlow[];
  readonly tier?: 'regression' | 'capability';
  readonly idGlob?: string;
  readonly fixturesDir?: string;
  /** Where run directories are created; defaults to `evals/results`. */
  readonly resultsDir?: string;
}

export interface ArmFlags {
  readonly preset?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface RunOptions extends CommonOptions {
  readonly k: number;
  readonly maxTokens: number;
  readonly reserveTokens: number;
  readonly maxWallMin?: number;
  readonly allowUnmetered: boolean;
  readonly keepWorkspaces: boolean;
  readonly dryRun: boolean;
  readonly baseline: ArmFlags;
}

export interface CandidateFlags {
  readonly templatesDir?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
}

export type Command =
  | { readonly kind: 'check'; readonly options: CommonOptions }
  | { readonly kind: 'run'; readonly options: RunOptions }
  | { readonly kind: 'compare'; readonly options: RunOptions; readonly candidate: CandidateFlags }
  | { readonly kind: 'report'; readonly baselinePath: string; readonly candidatePath: string };

export const DEFAULT_K = 3;

export const USAGE = `pnpm eval <command>

  check   [--flow a,b] [--tier T] [--fixture GLOB]                 0 tokens: prove every fixture label
  run     --max-tokens N [--flow a,b] [--tier regression|capability] [--fixture GLOB] [-k 3]
          [--preset P] [--provider P --model M --effort E] [--reserve-tokens N] [--max-wall-min M]
          [--allow-unmetered] [--keep-workspaces] [--dry-run]       one arm, live
  compare --max-tokens N (--candidate-templates DIR | --candidate-model M [--candidate-provider P]
          [--candidate-effort E]) …same flags as run                two arms, interleaved per item
  report  <baseline/results.json> <candidate/results.json>         0 tokens: offline paired analysis

Flows: ${EVAL_FLOWS.join(', ')}. See .claude/docs/EVALS.md.`;

const fail = (field: string, value: unknown, message: string): Result<never, ValidationError> =>
  Result.error(new ValidationError({ field, value, message, hint: 'run `pnpm eval` with no arguments for usage' }));

const parseFlows = (raw: string | undefined): Result<readonly EvalFlow[], ValidationError> => {
  if (raw === undefined) return Result.ok([]);
  const flows = raw.split(',').map((f) => f.trim());
  const bad = flows.find((f) => !(EVAL_FLOWS as readonly string[]).includes(f));
  return bad === undefined
    ? Result.ok(flows as EvalFlow[])
    : fail('flow', bad, `unknown flow '${bad}' (one of ${EVAL_FLOWS.join(', ')})`);
};

const positiveInt = (field: string, raw: string | undefined, fallback?: number): Result<number, ValidationError> => {
  if (raw === undefined)
    return fallback !== undefined ? Result.ok(fallback) : fail(field, raw, `--${field} is required`);
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Result.ok(n) : fail(field, raw, `--${field} must be a positive integer`);
};

const OPTIONS = {
  flow: { type: 'string' },
  tier: { type: 'string' },
  fixture: { type: 'string' },
  'fixtures-dir': { type: 'string' },
  'results-dir': { type: 'string' },
  k: { type: 'string', short: 'k' },
  preset: { type: 'string' },
  provider: { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  'max-tokens': { type: 'string' },
  'reserve-tokens': { type: 'string' },
  'max-wall-min': { type: 'string' },
  'allow-unmetered': { type: 'boolean' },
  'keep-workspaces': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'candidate-templates': { type: 'string' },
  'candidate-model': { type: 'string' },
  'candidate-provider': { type: 'string' },
  'candidate-effort': { type: 'string' },
} as const;

const buildCommon = (v: {
  flow?: string | undefined;
  tier?: string | undefined;
  fixture?: string | undefined;
  'fixtures-dir'?: string | undefined;
  'results-dir'?: string | undefined;
}): Result<CommonOptions, ValidationError> => {
  const flows = parseFlows(v.flow);
  if (!flows.ok) return Result.error(flows.error);
  if (v.tier !== undefined && v.tier !== 'regression' && v.tier !== 'capability') {
    return fail('tier', v.tier, `--tier must be 'regression' or 'capability'`);
  }
  return Result.ok({
    flows: flows.value,
    ...(v.tier !== undefined ? { tier: v.tier } : {}),
    ...(v.fixture !== undefined ? { idGlob: v.fixture } : {}),
    ...(v['fixtures-dir'] !== undefined ? { fixturesDir: v['fixtures-dir'] } : {}),
    ...(v['results-dir'] !== undefined ? { resultsDir: v['results-dir'] } : {}),
  });
};

export const parseCommand = (argv: readonly string[]): Result<Command, ValidationError> => {
  const [name, ...rest] = argv;
  if (name === undefined || name === '--help' || name === '-h') return fail('command', name, USAGE);
  if (name !== 'check' && name !== 'run' && name !== 'compare' && name !== 'report') {
    return fail('command', name, `unknown command '${name}'`);
  }

  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...rest], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (cause) {
    return fail('args', rest.join(' '), cause instanceof Error ? cause.message : String(cause));
  }
  const { values, positionals } = parsed;

  if (name === 'report') {
    const [baselinePath, candidatePath] = positionals;
    if (baselinePath === undefined || candidatePath === undefined || positionals.length !== 2) {
      return fail(
        'report',
        positionals.join(' '),
        'report needs exactly two paths: <baseline/results.json> <candidate/results.json>'
      );
    }
    return Result.ok({ kind: 'report', baselinePath, candidatePath });
  }
  if (positionals.length > 0)
    return fail('args', positionals.join(' '), `unexpected argument '${positionals[0] ?? ''}'`);

  const common = buildCommon(values);
  if (!common.ok) return Result.error(common.error);
  if (name === 'check') return Result.ok({ kind: 'check', options: common.value });

  const k = positiveInt('k', values.k, DEFAULT_K);
  if (!k.ok) return Result.error(k.error);
  const maxTokens = positiveInt('max-tokens', values['max-tokens']);
  if (!maxTokens.ok) return Result.error(maxTokens.error);
  const reserve =
    values['reserve-tokens'] === undefined ? Result.ok(0) : positiveInt('reserve-tokens', values['reserve-tokens']);
  if (!reserve.ok) return Result.error(reserve.error);
  const wall =
    values['max-wall-min'] === undefined ? Result.ok(undefined) : positiveInt('max-wall-min', values['max-wall-min']);
  if (!wall.ok) return Result.error(wall.error);

  const options: RunOptions = {
    ...common.value,
    k: k.value,
    maxTokens: maxTokens.value,
    reserveTokens: reserve.value,
    ...(wall.value !== undefined ? { maxWallMin: wall.value } : {}),
    allowUnmetered: values['allow-unmetered'] === true,
    keepWorkspaces: values['keep-workspaces'] === true,
    dryRun: values['dry-run'] === true,
    baseline: {
      ...(values.preset !== undefined ? { preset: values.preset } : {}),
      ...(values.provider !== undefined ? { provider: values.provider } : {}),
      ...(values.model !== undefined ? { model: values.model } : {}),
      ...(values.effort !== undefined ? { effort: values.effort } : {}),
    },
  };
  if (name === 'run') {
    const stray = ['candidate-templates', 'candidate-model', 'candidate-provider', 'candidate-effort'].find(
      (f) => values[f as keyof typeof values] !== undefined
    );
    return stray === undefined
      ? Result.ok({ kind: 'run', options })
      : fail(stray, true, `--${stray} belongs to \`compare\``);
  }

  const templatesDir = values['candidate-templates'];
  const model = values['candidate-model'];
  if ((templatesDir === undefined) === (model === undefined)) {
    return fail(
      'candidate',
      undefined,
      'compare needs exactly one of --candidate-templates DIR or --candidate-model M'
    );
  }
  if (
    templatesDir !== undefined &&
    (values['candidate-provider'] !== undefined || values['candidate-effort'] !== undefined)
  ) {
    return fail(
      'candidate-provider',
      values['candidate-provider'],
      '--candidate-provider / --candidate-effort go with --candidate-model, not --candidate-templates'
    );
  }
  return Result.ok({
    kind: 'compare',
    options,
    candidate: {
      ...(templatesDir !== undefined ? { templatesDir } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(values['candidate-provider'] !== undefined ? { provider: values['candidate-provider'] } : {}),
      ...(values['candidate-effort'] !== undefined ? { effort: values['candidate-effort'] } : {}),
    },
  });
};
