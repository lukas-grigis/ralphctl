import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { LaunchExtras } from '@src/application/ui/shared/launcher.ts';

/**
 * Validate and shape the four bare-`ralphctl` flags that override the persisted
 * `settings.ai.implement` pair for one launch:
 *
 *   --implement-generator-provider <claude-code|github-copilot|openai-codex>
 *   --implement-generator-model    <id>
 *   --implement-evaluator-provider <claude-code|github-copilot|openai-codex>
 *   --implement-evaluator-model    <id>
 *
 * Each role is `{ provider, model }` together. Supplying only one half of a pair is rejected
 * with a focused message naming the required matching flag — the operator should never end
 * up with a half-baked override silently falling back to the persisted row.
 */

export type ParseImplementRoleOverridesResult =
  | { readonly ok: true; readonly overrides: NonNullable<LaunchExtras['implementRoleOverrides']> | undefined }
  | { readonly ok: false; readonly error: string };

export interface ImplementRoleFlagsInput {
  readonly generatorProvider?: string;
  readonly generatorModel?: string;
  readonly evaluatorProvider?: string;
  readonly evaluatorModel?: string;
}

const ALLOWED_PROVIDERS: ReadonlySet<AiProvider> = new Set(['claude-code', 'github-copilot', 'openai-codex']);

const isAiProvider = (v: string): v is AiProvider => ALLOWED_PROVIDERS.has(v as AiProvider);

const parseRole = (
  role: 'generator' | 'evaluator',
  provider: string | undefined,
  model: string | undefined
): { ok: true; row?: { provider: AiProvider; model: string } } | { ok: false; error: string } => {
  // Validate well-formed pair: both flags or neither. The error message names the missing
  // counterpart so the operator sees exactly which flag to add. We surface this before any
  // value validation so a typo'd provider on the supplied half doesn't shadow the more
  // actionable "you forgot the matching flag" message.
  if (provider !== undefined && model === undefined) {
    return {
      ok: false,
      error: `--implement-${role}-provider requires --implement-${role}-model (both must be supplied together).`,
    };
  }
  if (model !== undefined && provider === undefined) {
    return {
      ok: false,
      error: `--implement-${role}-model requires --implement-${role}-provider (both must be supplied together).`,
    };
  }
  if (provider === undefined || model === undefined) {
    return { ok: true };
  }
  if (!isAiProvider(provider)) {
    return {
      ok: false,
      error: `--implement-${role}-provider: '${provider}' is not a supported provider (claude-code | github-copilot | openai-codex).`,
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
