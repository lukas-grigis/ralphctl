import type { AiProvider } from '@src/domain/entity/settings.ts';
import { AI_PROVIDERS_HINT, isAiProvider } from '@src/domain/entity/settings.ts';
import type { LaunchExtras } from '@src/application/ui/shared/launcher.ts';

/** Validate and shape the four bare-`ralphctl` flags that override the persisted `settings.ai.implement` pair for one launch. */
export type ParseImplementRoleOverridesResult =
  | { readonly ok: true; readonly overrides: NonNullable<LaunchExtras['implementRoleOverrides']> | undefined }
  | { readonly ok: false; readonly error: string };

export interface ImplementRoleFlagsInput {
  readonly generatorProvider?: string | undefined;
  readonly generatorModel?: string | undefined;
  readonly evaluatorProvider?: string | undefined;
  readonly evaluatorModel?: string | undefined;
}

const parseRole = (
  role: 'generator' | 'evaluator',
  provider: string | undefined,
  model: string | undefined
): { ok: true; row?: { provider: AiProvider; model: string } } | { ok: false; error: string } => {
  // Both flags or neither; name the missing counterpart so the operator knows which flag to add.
  if ((provider === undefined) !== (model === undefined)) {
    const [have, need] = provider === undefined ? ['model', 'provider'] : ['provider', 'model'];
    return {
      ok: false,
      error: `--implement-${role}-${have} requires --implement-${role}-${need} (both must be supplied together).`,
    };
  }
  if (provider === undefined || model === undefined) {
    return { ok: true };
  }
  if (!isAiProvider(provider)) {
    return {
      ok: false,
      error: `--implement-${role}-provider: '${provider}' is not a supported provider (${AI_PROVIDERS_HINT}).`,
    };
  }
  const trimmedModel = model.trim();
  if (trimmedModel.length === 0) {
    return { ok: false, error: `--implement-${role}-model must be a non-empty string.` };
  }
  return { ok: true, row: { provider, model: trimmedModel } };
};

export const parseImplementRoleOverrides = (input: ImplementRoleFlagsInput): ParseImplementRoleOverridesResult => {
  const generator = parseRole('generator', input.generatorProvider, input.generatorModel);
  if (!generator.ok) return { ok: false, error: generator.error };
  const evaluator = parseRole('evaluator', input.evaluatorProvider, input.evaluatorModel);
  if (!evaluator.ok) return { ok: false, error: evaluator.error };
  if (generator.row === undefined && evaluator.row === undefined) {
    return { ok: true, overrides: undefined };
  }
  return {
    ok: true,
    overrides: {
      ...(generator.row !== undefined ? { generator: generator.row } : {}),
      ...(evaluator.row !== undefined ? { evaluator: evaluator.row } : {}),
    },
  };
};
