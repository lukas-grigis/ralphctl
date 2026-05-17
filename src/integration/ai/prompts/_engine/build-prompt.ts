import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { assertFullySubstituted, substitute } from '@src/integration/ai/prompts/_engine/substitute.ts';
import type { ParameterSpec, PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';

/** Aggregate error type returned by `buildPrompt`. */
export type BuildPromptError = StorageError | ParseError | ValidationError;

/**
 * Generic prompt builder. Reads a `PromptDefinition` and a typed input bag, loads the
 * template + any partials, validates each input field via its spec, runs substitution, and
 * brands the result as `Prompt` after `assertFullySubstituted` confirms no placeholders
 * remain.
 *
 * Pure orchestration — no domain knowledge baked in. Per-prompt modules expose ergonomic
 * top-level builders (`buildRefinePrompt`, `buildPlanPrompt`, …) that pre-render domain
 * types into strings before calling this entry.
 *
 * Failure modes:
 *  - Missing template or partial → `StorageError(io)`
 *  - Required input missing or `validate` rejected → `ValidationError`
 *  - Placeholder not filled (template/manifest drift) → `ParseError(schema-mismatch)`
 */
export const buildPrompt = async <TInput extends object>(
  loader: TemplateLoader,
  def: PromptDefinition<TInput>,
  input: TInput
): Promise<Result<Prompt, BuildPromptError>> => {
  const template = await loader.load(def.templateName);
  if (!template.ok) return Result.error(template.error);

  const values: Record<string, string> = {};

  // Auto-loaded partials. Bodies are trimmed so trailing whitespace from the partial file
  // doesn't bleed into the rendered prompt.
  if (def.partials !== undefined) {
    for (const [placeholder, name] of Object.entries(def.partials)) {
      const partial = await loader.load(name);
      if (!partial.ok) return Result.error(partial.error);
      values[placeholder] = partial.value.trim();
    }
  }

  // Per-parameter validation + substitution.
  // Iterating typed entries is impossible without a runtime cast — we lose `TInput`'s shape
  // when iterating Object.entries. The cast is safe: `def.parameters` is constructed from
  // `TInput` at the type level, and `input` is typed as `TInput` at the call site.
  for (const [field, rawSpec] of Object.entries(def.parameters) as Array<[string, ParameterSpec<unknown>]>) {
    const spec = rawSpec;
    const rawValue = (input as Record<string, unknown>)[field];

    if (rawValue === undefined || rawValue === null) {
      if (spec.optional === true) {
        values[spec.placeholder] = '';
        continue;
      }
      return Result.error(
        new ValidationError({
          field,
          value: rawValue,
          message: `buildPrompt(${def.templateName}): required parameter '${field}' (placeholder ${spec.placeholder}) is missing`,
        })
      );
    }

    const validated = spec.validate ? spec.validate(rawValue) : Result.ok(rawValue);
    if (!validated.ok) return Result.error(validated.error);

    values[spec.placeholder] = String(validated.value as unknown);
  }

  const rendered = substitute(template.value, values);
  return assertFullySubstituted(rendered, `buildPrompt(${def.templateName})`);
};
