import type { EvalFlow } from './fixture-schema.ts';
import type { FlowAdapter } from './flows/adapter.ts';
import { detectScriptsAdapter } from './flows/detect-scripts.ts';
import { evaluateAdapter } from './flows/evaluate.ts';
import { implementAdapter } from './flows/implement.ts';
import { selectCandidateAdapter } from './flows/select-candidate.ts';

/**
 * Every headless flow the harness can evaluate. plan / ideate / refine are interactive-only (no
 * `HeadlessAiProvider` path ships for them) and check-plan makes no model call, so none belong here.
 */
export const ADAPTERS: Readonly<Record<EvalFlow, FlowAdapter>> = {
  evaluate: evaluateAdapter,
  implement: implementAdapter,
  'detect-scripts': detectScriptsAdapter,
  'select-candidate': selectCandidateAdapter,
};
