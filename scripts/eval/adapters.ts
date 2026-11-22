import type { EvalFlow } from './fixture-schema.ts';
import type { FlowAdapter } from './flows/adapter.ts';
import { detectScriptsAdapter } from './flows/detect-scripts.ts';
import { evaluateAdapter } from './flows/evaluate.ts';
import { implementAdapter } from './flows/implement.ts';
import { refineAdapter } from './flows/refine.ts';
import { selectCandidateAdapter } from './flows/select-candidate.ts';

/**
 * Every flow the harness can evaluate. refine ships interactive-only but runs here headless against
 * a scripted operator (`flows/refine.ts`); plan / ideate have no such operator yet and check-plan
 * makes no model call, so none of those belong here.
 */
export const ADAPTERS: Readonly<Record<EvalFlow, FlowAdapter>> = {
  evaluate: evaluateAdapter,
  implement: implementAdapter,
  'detect-scripts': detectScriptsAdapter,
  'select-candidate': selectCandidateAdapter,
  refine: refineAdapter,
};
