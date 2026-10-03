import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import { assertTemplateKeysFilled, substitute } from '@src/integration/ai/prompts/_engine/substitute.ts';
import type { ParameterSpec, PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';

/** Aggregate error type returned by `buildPrompt`. */
export type BuildPromptError = StorageError | ParseError | ValidationError;

/**
 * A parameter can never share a placeholder with an auto-loaded partial slot — `buildPrompt`
 * populates `values` from partials first, so a colliding parameter would silently clobber the
 * partial's rendered content instead of failing loudly. Returns the first collision found (a
 * `[field, placeholder]` pair), or `undefined` when there is none. Definition-authoring bug,
 * caught once up front rather than left to whichever field happens to iterate last.
 */
const findPartialParameterCollision = <TInput extends object>(
  def: PromptDefinition<TInput>,
  partialPlaceholders: ReadonlySet<string>
): readonly [field: string, placeholder: string] | undefined => {
  for (const [field, rawSpec] of Object.entries(def.parameters) as Array<[string, ParameterSpec<unknown>]>) {
    if (partialPlaceholders.has(rawSpec.placeholder)) return [field, rawSpec.placeholder];
  }
  return undefined;
};

/**
 * Validates each declared parameter against `input` and fills the substitution map with its
 * rendered string value.
 */
const validateAndFillParameters = <TInput extends object>(
  def: PromptDefinition<TInput>,
  input: TInput
): Result<Record<string, string>, ValidationError> => {
  const values: Record<string, string> = {};

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

  return Result.ok(values);
};

// Partials are inserted verbatim (trimmed), so a placeholder inside one could never be filled.
const loadPartials = async <TInput extends object>(
  loader: TemplateLoader,
  def: PromptDefinition<TInput>
): Promise<Result<Record<string, string>, StorageError | ParseError>> => {
  const values: Record<string, string> = {};
  for (const [placeholder, name] of Object.entries(def.partials ?? {})) {
    const partial = await loader.load(name);
    if (!partial.ok) return Result.error(partial.error);
    const nested = extractPlaceholders(partial.value);
    if (nested.length > 0) {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message:
            `buildPrompt(${def.templateName}): partial '${name}' contains placeholder(s) ` +
            `${nested.map((k) => `{{${k}}}`).join(', ')} — partials are inserted verbatim (single pass), ` +
            `so placeholders inside them are never filled.`,
        })
      );
    }
    values[placeholder] = partial.value.trim();
  }
  return Result.ok(values);
};

/**
 * Generic prompt builder. Reads a `PromptDefinition` and a typed input bag, loads the
 * template + any partials, validates each input field via its spec, runs substitution, and
 * brands the result as `Prompt` after `assertTemplateKeysFilled` confirms every placeholder
 * the template declares received a value. The fence is TEMPLATE-side on
 * purpose: substituted values may legally contain placeholder-shaped literals (AI-authored
 * journal/critique text quoting a `{{TOKEN}}`), which pass through verbatim as inert prose.
 *
 * Pure orchestration — no domain knowledge baked in. Per-prompt modules expose ergonomic
 * top-level builders (`buildRefinePrompt`, `buildPlanPrompt`, …) that pre-render domain
 * types into strings before calling this entry.
 *
 * Failure modes:
 *  - Missing template or partial → `StorageError(io)`
 *  - Required input missing or `validate` rejected → `ValidationError`
 *  - Placeholder not filled (template/manifest drift) → `ParseError(schema-mismatch)`
 *  - Partial body contains a placeholder (never filled, single pass) → `ParseError(schema-mismatch)`
 */
export const buildPrompt = async <TInput extends object>(
  loader: TemplateLoader,
  def: PromptDefinition<TInput>,
  input: TInput
): Promise<Result<Prompt, BuildPromptError>> => {
  const template = await loader.load(def.templateName);
  if (!template.ok) return Result.error(template.error);

  const values: Record<string, string> = {};
  const partialPlaceholders = new Set<string>(def.partials !== undefined ? Object.keys(def.partials) : []);

  const collision = findPartialParameterCollision(def, partialPlaceholders);
  if (collision !== undefined) {
    const [field, placeholder] = collision;
    return Result.error(
      new ValidationError({
        field,
        value: placeholder,
        message:
          `buildPrompt(${def.templateName}): parameter '${field}' declares placeholder ` +
          `{{${placeholder}}}, which collides with an auto-loaded partial slot of the same ` +
          `name — rename one of them.`,
      })
    );
  }

  const partials = await loadPartials(loader, def);
  if (!partials.ok) return Result.error(partials.error);
  Object.assign(values, partials.value);

  // Per-parameter validation + substitution.
  const filled = validateAndFillParameters(def, input);
  if (!filled.ok) return Result.error(filled.error);
  Object.assign(values, filled.value);

  const untrusted: Record<string, string> = {};
  for (const spec of Object.values(def.parameters) as Array<ParameterSpec<unknown>>) {
    if (spec.untrusted !== undefined) untrusted[spec.placeholder] = spec.untrusted.source;
  }
  const rendered = substitute(template.value, values, untrusted);
  return assertTemplateKeysFilled(rendered, template.value, values, `buildPrompt(${def.templateName})`);
};
