import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import { applyFeedbackPromptDef } from '@src/integration/ai/prompts/apply-feedback/definition.ts';
import { createPrPromptDef } from '@src/integration/ai/prompts/create-pr/definition.ts';
import { detectScriptsPromptDef } from '@src/integration/ai/prompts/detect-scripts/definition.ts';
import { detectSkillsPromptDef } from '@src/integration/ai/prompts/detect-skills/definition.ts';
import { distillLearningsPromptDef } from '@src/integration/ai/prompts/distill-learnings/definition.ts';
import { evaluateContinuationPromptDef } from '@src/integration/ai/prompts/evaluate-continuation/definition.ts';
import { evaluatePromptDef } from '@src/integration/ai/prompts/evaluate/definition.ts';
import { ideatePromptDef } from '@src/integration/ai/prompts/ideate/definition.ts';
import { implementContinuationPromptDef } from '@src/integration/ai/prompts/implement-continuation/definition.ts';
import { implementCrashResumePromptDef } from '@src/integration/ai/prompts/implement-crash-resume/definition.ts';
import { implementPromptDef } from '@src/integration/ai/prompts/implement/definition.ts';
import { planPromptDef } from '@src/integration/ai/prompts/plan/definition.ts';
import { readinessPromptDef } from '@src/integration/ai/prompts/readiness/definition.ts';
import { refinePromptDef } from '@src/integration/ai/prompts/refine/definition.ts';
import { reproducePromptDef } from '@src/integration/ai/prompts/reproduce/definition.ts';
import { selectCandidatePromptDef } from '@src/integration/ai/prompts/select-candidate/definition.ts';

/** Every prompt definition, one per `src/integration/ai/prompts/<flow>/` directory (`template-coverage.test.ts` enforces it). */
export const ALL_PROMPT_DEFS: ReadonlyArray<PromptDefinition<object>> = [
  applyFeedbackPromptDef,
  createPrPromptDef,
  detectScriptsPromptDef,
  detectSkillsPromptDef,
  distillLearningsPromptDef,
  evaluateContinuationPromptDef,
  evaluatePromptDef,
  ideatePromptDef,
  implementContinuationPromptDef,
  implementCrashResumePromptDef,
  implementPromptDef,
  planPromptDef,
  readinessPromptDef,
  refinePromptDef,
  reproducePromptDef,
  selectCandidatePromptDef,
];
