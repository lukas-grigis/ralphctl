import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import type { ParameterSpec, PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

/** Resolve every partial declared on a `PromptDefinition` to its trimmed on-disk body, keyed by placeholder. */
export const loadPartialMap = async (
  def: PromptDefinition<object>,
  loader: TemplateLoader
): Promise<Record<string, string>> => {
  const map: Record<string, string> = {};
  for (const [placeholder, partialName] of Object.entries(def.partials ?? {})) {
    const partial = await loader.load(partialName);
    if (!partial.ok) {
      throw new Error(
        `loadPartialMap: failed to load partial '${partialName}' for placeholder '${placeholder}' on prompt '${def.templateName}': ${partial.error.message}`
      );
    }
    map[placeholder] = partial.value.trim();
  }
  return map;
};

/**
 * Two-sided diff between the placeholders a template needs and the ones its definition declares,
 * computed over the template with partials inlined (single pass, as `buildPrompt` does).
 *
 *   - `unsatisfied`  — referenced after expansion but no matching parameter.
 *   - `unreferenced` — declared (parameter or partial slot) but used neither in the raw template
 *                      nor in any partial body.
 */
export const computePlaceholderParity = (params: {
  readonly def: PromptDefinition<object>;
  readonly rawTemplate: string;
  readonly partials: Readonly<Record<string, string>>;
}): {
  readonly declaredParameters: readonly string[];
  readonly declaredPartials: readonly string[];
  readonly unsatisfied: readonly string[];
  readonly unreferenced: readonly string[];
} => {
  const declaredParameters = Object.values(params.def.parameters).map(
    (spec) => (spec as ParameterSpec<unknown>).placeholder
  );
  const declaredPartials = Object.keys(params.def.partials ?? {});

  const expanded = params.rawTemplate.replace(
    /\{\{([A-Z][A-Z0-9_]*)\}\}/g,
    (match, key: string) => params.partials[key] ?? match
  );
  const referencedAnywhere = new Set([
    ...extractPlaceholders(params.rawTemplate),
    ...Object.values(params.partials).flatMap((body) => extractPlaceholders(body)),
  ]);
  const paramSet = new Set(declaredParameters);

  return {
    declaredParameters: [...paramSet].sort(),
    declaredPartials: [...declaredPartials].sort(),
    unsatisfied: [...new Set(extractPlaceholders(expanded))].filter((p) => !paramSet.has(p)).sort(),
    unreferenced: [
      ...new Set([...declaredParameters, ...declaredPartials].filter((p) => !referencedAnywhere.has(p))),
    ].sort(),
  };
};
