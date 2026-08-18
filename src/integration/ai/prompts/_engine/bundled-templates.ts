/**
 * Canonical inventory of every prompt asset shipped in the bundle — the names
 * `TemplateLoader.load()` must be able to resolve on an installed package.
 *
 * Why this exists at all: `resolveTemplatesDir` (fs-template-loader.ts) probes for a `prompts/`
 * directory beside the running module and falls back SILENTLY to the package root when it is
 * missing, which is exactly how 0.15.0 shipped a bundle that served no templates. Nothing
 * reachable from a non-interactive CLI command used to touch that resolver — `skills list` /
 * `agents list` exercise their own copies of the probe, and `bundle-integrity` existence-checks
 * the manifest through a third copy — so the dist smoke could stay green with every prompt
 * unreadable. `ralphctl prompts list` walks this list through the real loader; a parity test pins
 * the list against the on-disk `src/integration/ai/prompts/` tree so a new prompt cannot land
 * without joining the gate.
 *
 * Names are loader names, not paths: a template resolves to `<dir>/<name>/template.md`, a partial
 * to `<dir>/_partials/<name>.md`.
 */

/** Per-flow prompt templates — `<dir>/<name>/template.md`. */
export const BUNDLED_PROMPT_TEMPLATES: readonly string[] = [
  'apply-feedback',
  'create-pr',
  'detect-scripts',
  'detect-skills',
  'distill-learnings',
  'evaluate',
  'evaluate-continuation',
  'ideate',
  'implement',
  'implement-continuation',
  'plan',
  'readiness',
  'refine',
  'reproduce',
  'select-candidate',
];

/** Cross-cutting partials — `<dir>/_partials/<name>.md`. */
export const BUNDLED_PROMPT_PARTIALS: readonly string[] = [
  'conventions-agents-md',
  'conventions-claude-md',
  'conventions-copilot-instructions',
  'decisions',
  'harness-context',
  'validation-checklist',
];
