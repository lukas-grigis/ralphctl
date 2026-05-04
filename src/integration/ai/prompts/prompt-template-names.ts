/**
 * Mapping from each `PromptBuilderPort` method to its source `.md`
 * template. Extracted into its own file so both the adapter and the
 * partials-loader can import it without creating a circular dependency.
 *
 * Re-exported by `prompt-builder-adapter.ts` so tests and tooling that
 * import `TEMPLATE_NAMES` from there continue to work without changes.
 */
export const TEMPLATE_NAMES = {
  refine: 'ticket-refine',
  // Outer plan templates — picked by `interactive` flag at build time.
  planInteractive: 'plan-interactive',
  planAuto: 'plan-auto',
  // Shared partials embedded by the planner.
  planCommon: 'plan-common',
  planCommonExamples: 'plan-common-examples',
  harnessContext: 'harness-context',
  validationChecklist: 'validation-checklist',
  signalsPlanning: 'signals-planning',
  signalsTask: 'signals-task',
  signalsEvaluation: 'signals-evaluation',
  ideate: 'ideate',
  execute: 'task-execution',
  evaluate: 'task-evaluation',
  feedback: 'sprint-feedback',
  onboard: 'repo-onboard',
} as const;
