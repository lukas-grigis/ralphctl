import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { type BuildPromptError, buildPrompt } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

/**
 * Pre-rendered string parameters for the create-pr template. `ticketSummary` is a markdown
 * block; `issueRefs` is a pre-computed list of `Closes #N` lines the AI threads verbatim into
 * the body. The headless session reads the rendered prompt and writes its answer to
 * `signals.json` per the contract.
 */
export interface CreatePrPromptParams {
  /** Base branch (e.g. `main`) — the PR target. */
  readonly baseBranch: string;
  /** Head branch — already pushed to `origin` by the upstream push-branch leaf. */
  readonly headBranch: string;
  /**
   * Markdown block listing the sprint's tickets (titles + links) so the AI has the
   * user-facing problem statement, not internal task names. Empty acceptable when the
   * sprint has no tickets — the prompt section degrades to "no specific tickets recorded"
   * via the caller's substitution.
   */
  readonly ticketSummary: string;
  /**
   * Verbatim block of `Closes <ref>` lines pre-computed from ticket + task `externalRef`s
   * via `normalizeRefs`. Empty when no refs exist; the prompt instructs the AI to omit the
   * trailing closes block in that case.
   */
  readonly issueRefs: string;
  /**
   * Audit-[09] output contract section — rendered from the create-pr `AiOutputContract` by
   * `renderContractSectionFor(generatePrContentOutputContract)`. Tells the AI to write
   * `signals.json` directly with one `pr-content` signal.
   */
  readonly outputContractSection: string;
}

export const createPrPromptDef: PromptDefinition<CreatePrPromptParams> = {
  templateName: 'create-pr',
  description:
    'Headless authoring of one pull-request title + body from the actual git diff against the base branch. The AI runs `git log` / `git diff` itself and writes its proposal to signals.json per the audit-[09] contract.',
  parameters: {
    baseBranch: {
      placeholder: 'BASE_BRANCH',
      description: 'PR target branch (e.g. `main`).',
      validate: (v: string) =>
        v.trim().length === 0
          ? Result.error(
              new ValidationError({ field: 'baseBranch', value: v, message: 'baseBranch must not be empty' })
            )
          : Result.ok(v),
    },
    headBranch: {
      placeholder: 'HEAD_BRANCH',
      description: 'Head branch — already pushed to origin by the upstream push-branch leaf.',
      validate: (v: string) =>
        v.trim().length === 0
          ? Result.error(
              new ValidationError({ field: 'headBranch', value: v, message: 'headBranch must not be empty' })
            )
          : Result.ok(v),
    },
    ticketSummary: {
      placeholder: 'TICKET_SUMMARY',
      description:
        'Markdown block listing the sprint tickets (title + link when set). Empty falls back to a "no tickets recorded" note in the prompt body — represented here as an empty value via the optional flag.',
      optional: true,
    },
    issueRefs: {
      placeholder: 'ISSUE_REFS',
      description:
        'Pre-computed `Closes <ref>` lines from ticket + task externalRefs. Empty when no refs exist; the prompt then instructs the AI to omit the trailing closes block.',
      optional: true,
    },
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description:
        'Audit-[09] output contract block rendered from the create-pr contract — instructs the AI to write `signals.json` directly with one `pr-content` signal.',
      validate: (v: string) =>
        v.trim().length === 0
          ? Result.error(
              new ValidationError({
                field: 'outputContractSection',
                value: v,
                message: 'output-contract section must not be empty',
              })
            )
          : Result.ok(v),
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
  },
  expectedSignals: ['pr-content'],
};

/**
 * Render a list of tickets into the markdown block the create-pr template's
 * `{{TICKET_SUMMARY}}` slot expects. Each ticket renders as a bullet with title + link
 * (when set). The empty list returns a placeholder note so the prompt section stays
 * coherent rather than collapsing into a blank section.
 */
export const renderTicketSummary = (
  tickets: ReadonlyArray<{ readonly title: string; readonly link?: string }>
): string => {
  if (tickets.length === 0) return '_No specific tickets recorded for this branch._';
  return tickets.map((t) => (t.link !== undefined ? `- ${t.title} (${t.link})` : `- ${t.title}`)).join('\n');
};

/**
 * Render the pre-computed `Closes <ref>` block. Refs already normalised by the caller; this
 * helper just joins them with newlines so the prompt substitutes a verbatim block the AI
 * mirrors at the bottom of the body.
 */
export const renderIssueRefs = (refs: readonly string[]): string => {
  if (refs.length === 0) return '';
  return refs.map((r) => `Closes ${r}`).join('\n');
};

/** Top-level builder — accepts pre-rendered params and runs the generic builder. */
export const buildCreatePrPrompt = async (
  deps: TemplateLoader,
  input: CreatePrPromptParams
): Promise<Result<Prompt, BuildPromptError>> => buildPrompt(deps, createPrPromptDef, input);
