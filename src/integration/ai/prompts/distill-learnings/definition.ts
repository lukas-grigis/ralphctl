/**
 * `distill-learnings` prompt: one-shot documentation edit that folds a curated set of
 * machine-collected learnings into an existing project context file's own idempotent learnings
 * section. The section heading is a parameter ({@link DistillLearningsPromptParams.learningsSectionHeading})
 * so the generic template never hardcodes a brand — it runs on downstream user projects, not just
 * this one.
 *
 * The AI is an editor, not a researcher — every learning was produced and reviewed by an earlier
 * session and confirmed by the operator before this call. The prompt instructs the AI to write
 * ONLY the reconciled body of the owned section to disk (no signals.json); the harness splices it
 * into the existing file (`spliceOwnedSection`), so everything outside the section is preserved
 * byte-for-byte and this prompt declares no expected harness signals.
 *
 * One real file is written per distinct provider's native context file name (CLAUDE.md /
 * `.github/copilot-instructions.md` / AGENTS.md) — `targetFilename` carries that name so the
 * prompt copy and the AI's write target agree. The distill sub-chain supplies the per-
 * provider value.
 */

import { type Result } from '@src/domain/result.ts';
import { requireNonEmpty } from '@src/integration/ai/prompts/_engine/validators.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

/**
 * Default H2 heading text for the section this prompt owns (without the leading `## `). Generic and
 * brand-free so the template stays portable across downstream user projects. Callers that want a
 * project-specific heading pass {@link DistillLearningsPromptParams.learningsSectionHeading}.
 */
export const DEFAULT_LEARNINGS_SECTION_HEADING = 'Learnings (AI sessions)';

export interface DistillLearningsPromptParams {
  /**
   * Existing context-file body wrapped for prompting, or an empty string when no file exists. The
   * AI reconciles the candidate learnings against this file's current learnings section (the one
   * headed by {@link DistillLearningsPromptParams.learningsSectionHeading}) and writes only that
   * section's updated body back.
   */
  readonly existingContextFile: string;
  /**
   * The curated learnings to fold in — rendered as a markdown list (one bullet per learning) by
   * the caller from the accepted {@link LearningRecord}s.
   */
  readonly candidateLearnings: string;
  /**
   * Native context-file name for the provider this call targets (e.g. `CLAUDE.md`,
   * `.github/copilot-instructions.md`, `AGENTS.md`). Both the prompt copy and the AI's write
   * target reference it, so the per-provider fan-out lands one file per provider.
   */
  readonly targetFilename: string;
  /**
   * Absolute path the AI writes the proposed learnings-section body to (not the whole file). The
   * harness reads it back, splices it into the existing file, shows the operator the full result,
   * and writes {@link DistillLearningsPromptParams.targetFilename}
   * itself after confirmation — the AI never touches the real context file.
   */
  readonly outputFile: string;
  /**
   * Detected project build/test/task tooling, or an explicit "(none detected)" line. The ONLY
   * place package-manager commands may appear — learnings that name a command are phrased against
   * this section so the prompt copy never hardcodes a specific ecosystem's commands.
   */
  readonly projectTooling: string;
  /**
   * H2 heading text for the section this prompt owns (without the leading `## `). Optional — omit it
   * to fall back to a generic, brand-free default ({@link DEFAULT_LEARNINGS_SECTION_HEADING}). The
   * template is generic and runs on downstream user projects, so the heading must never hardcode a
   * brand; callers that want a project-specific heading pass it here.
   */
  readonly learningsSectionHeading?: string;
}

export const distillLearningsPromptDef: PromptDefinition<DistillLearningsPromptParams> = {
  templateName: 'distill-learnings',
  description:
    'One-shot documentation edit that folds curated learnings into the owned idempotent learnings section of a project context file — the model writes only the section body (heading configurable, brand-free by default).',
  parameters: {
    existingContextFile: {
      placeholder: 'EXISTING_CONTEXT_FILE',
      description: 'Existing context-file body wrapped for prompting, or an empty string when no file exists.',
      untrusted: { source: 'the existing project context file' },
    },
    candidateLearnings: {
      placeholder: 'CANDIDATE_LEARNINGS',
      description: 'Markdown list of the curated learnings to fold into the context file.',
      validate: requireNonEmpty('candidateLearnings', 'candidate learnings must not be empty'),
      untrusted: { source: 'learnings recorded by earlier AI sessions' },
    },
    targetFilename: {
      placeholder: 'TARGET_FILENAME',
      description:
        'Native context-file name for the target provider (CLAUDE.md / .github/copilot-instructions.md / AGENTS.md).',
      validate: requireNonEmpty('targetFilename', 'target filename must not be empty'),
    },
    outputFile: {
      placeholder: 'OUTPUT_FILE',
      description:
        'Absolute path the AI writes the proposed learnings-section body to (harness-owned; the harness splices it into the file).',
      validate: requireNonEmpty('outputFile', 'output file must not be empty'),
    },
    projectTooling: {
      placeholder: 'PROJECT_TOOLING',
      description:
        'Detected build/test/task tooling, or "(none detected)". The only place package-manager commands may appear.',
    },
    learningsSectionHeading: {
      placeholder: 'LEARNINGS_SECTION_HEADING',
      description:
        'H2 heading text for the owned learnings section (without the leading `## `). Brand-free generic default applied by the builder when the caller omits it.',
      optional: true,
    },
  },
  partials: {},
  // The AI writes only the learnings-section body to the harness output path; no harness signals.
  expectedSignals: [],
};

export interface BuildDistillLearningsPromptInput {
  readonly existingContextFile: string;
  readonly candidateLearnings: string;
  readonly targetFilename: string;
  readonly outputFile: string;
  readonly projectTooling: string;
  /** Optional H2 heading for the owned section; falls back to the brand-free default when omitted. */
  readonly learningsSectionHeading?: string;
}

/**
 * Top-level builder — the distill-propose step renders the prompt with this before the AI spawn.
 */
export const buildDistillLearningsPrompt = async (
  loader: TemplateLoader,
  input: BuildDistillLearningsPromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(loader, distillLearningsPromptDef, {
    existingContextFile: input.existingContextFile,
    candidateLearnings: input.candidateLearnings,
    targetFilename: input.targetFilename,
    outputFile: input.outputFile,
    projectTooling: input.projectTooling,
    learningsSectionHeading: input.learningsSectionHeading ?? DEFAULT_LEARNINGS_SECTION_HEADING,
  });
