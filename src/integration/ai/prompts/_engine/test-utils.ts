import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import type { ParameterSpec, PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

export { extractPlaceholders };

/**
 * Recursive partial expansion. `template` is the outer body; `partials` maps placeholder
 * key → partial body. The function performs N substitution passes (capped at
 * `MAX_PARTIAL_DEPTH`) so that a partial referencing another partial is fully inlined.
 *
 * Detects cycles: if a pass produces no change but placeholders for known partials remain,
 * that means a partial transitively references itself; the function throws so the test fails
 * loudly instead of looping forever.
 *
 * Unknown `{{KEY}}` placeholders are left intact — they are template parameters the runtime
 * builder fills, not partials.
 */
const MAX_PARTIAL_DEPTH = 8;

export const expandPartials = (template: string, partials: Readonly<Record<string, string>>): string => {
  let body = template;
  for (let depth = 0; depth < MAX_PARTIAL_DEPTH; depth++) {
    const before = body;
    body = body.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (match, key: string) => {
      const replacement = partials[key];
      return replacement !== undefined ? replacement : match;
    });
    if (body === before) return body;
  }
  const remaining = extractPlaceholders(body).filter((p) => Object.prototype.hasOwnProperty.call(partials, p));
  if (remaining.length > 0) {
    throw new Error(
      `expandPartials: depth limit reached with unresolved partial keys: ${remaining.join(', ')}. Probable cycle.`
    );
  }
  return body;
};

/**
 * Resolve every partial declared on a `PromptDefinition` to its on-disk body via the loader.
 * Returns a placeholder-keyed map ready for `expandPartials`.
 */
export const loadPartialMap = async (
  def: PromptDefinition<object>,
  loader: TemplateLoader
): Promise<Record<string, string>> => {
  const map: Record<string, string> = {};
  if (def.partials === undefined) return map;
  for (const [placeholder, partialName] of Object.entries(def.partials)) {
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
 * Two-sided diff between placeholders the template needs and placeholders the definition
 * declares. Inputs are computed over the **expanded** template (partials inlined), so
 * remaining placeholders are exactly the runtime parameters the builder must fill.
 *
 *   - `unsatisfied`  — referenced in the expanded template but no matching parameter.
 *   - `unreferenced` — declared on the def but never used (in the raw template, in any
 *                      partial body, or as a partial-key placeholder).
 */
export interface PlaceholderParityReport {
  readonly declaredParameters: readonly string[];
  readonly declaredPartials: readonly string[];
  readonly unsatisfied: readonly string[];
  readonly unreferenced: readonly string[];
}

export const computePlaceholderParity = (params: {
  readonly def: PromptDefinition<object>;
  readonly rawTemplate: string;
  readonly partials: Readonly<Record<string, string>>;
}): PlaceholderParityReport => {
  const declaredParameters = Object.values(params.def.parameters).map(
    (spec) => (spec as ParameterSpec<unknown>).placeholder
  );
  const declaredPartials = params.def.partials !== undefined ? Object.keys(params.def.partials) : [];

  const expanded = expandPartials(params.rawTemplate, params.partials);
  const referencedInExpanded = new Set<string>(extractPlaceholders(expanded));

  // For the "unreferenced" check we also look inside every partial body — a parameter may be
  // declared only because a partial references it. The union covers both call sites.
  const referencedAnywhere = new Set<string>(extractPlaceholders(params.rawTemplate));
  for (const body of Object.values(params.partials)) {
    for (const p of extractPlaceholders(body)) referencedAnywhere.add(p);
  }

  const paramSet = new Set<string>(declaredParameters);
  const partialSet = new Set<string>(declaredPartials);

  const unsatisfied = [...referencedInExpanded].filter((p) => !paramSet.has(p)).sort();
  const unreferencedParameters = declaredParameters.filter((p) => !referencedAnywhere.has(p));
  const unreferencedPartials = declaredPartials.filter((p) => !referencedAnywhere.has(p));
  const unreferenced = [...new Set([...unreferencedParameters, ...unreferencedPartials])].sort();

  return {
    declaredParameters: [...paramSet].sort(),
    declaredPartials: [...partialSet].sort(),
    unsatisfied,
    unreferenced,
  };
};
