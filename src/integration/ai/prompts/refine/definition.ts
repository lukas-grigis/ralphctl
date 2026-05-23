import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { type BuildPromptError, buildPrompt } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

/**
 * Pre-rendered string parameters for the refine template. `ticket` and `issueContext` are
 * markdown blocks; `outputFilePath` is the absolute path the AI is told to write its final
 * answer to. The interactive Claude session reads `prompt.md` (rendered from this template)
 * and writes the body to `outputFilePath`. The harness reads that file back after the
 * session exits.
 */
export interface RefinePromptParams {
  /** Markdown block describing the ticket (title, id, link, description). */
  readonly ticket: string;
  /** Optional `<context>...</context>` block with the upstream issue body or bare link. */
  readonly issueContext?: string;
  /**
   * Audit-[09] output contract section — rendered from the refine `AiOutputContract` by
   * `renderContractSectionFor(refineOutputContract)`. Tells the AI to write `signals.json`
   * directly with one `refined-ticket` signal whose `body` carries the requirements markdown.
   */
  readonly outputContractSection: string;
  /**
   * Current body of `progress.md` substituted into the `## Prior progress on this sprint`
   * section (audit-[07]). Empty when the journal has no entries yet.
   */
  readonly priorProgress: string;
}

export const refinePromptDef: PromptDefinition<RefinePromptParams> = {
  templateName: 'refine',
  description:
    'Interactive requirements refinement for one pending ticket. The AI interviews the user; output is a markdown requirements document the AI writes to a file path the harness reads back.',
  parameters: {
    ticket: {
      placeholder: 'TICKET',
      description: 'Markdown block rendering the ticket title, id, link (when set), and description (when set).',
      validate: (v: string) =>
        v.trim().length === 0
          ? Result.error(
              new ValidationError({ field: 'ticket', value: v, message: 'rendered ticket block must not be empty' })
            )
          : Result.ok(v),
    },
    issueContext: {
      placeholder: 'ISSUE_CONTEXT',
      description:
        '`<context>...</context>` block with pre-fetched upstream issue body, bare link fallback, or empty when neither is available.',
      optional: true,
    },
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description:
        'Audit-[09] output contract block rendered from the refine contract — instructs the AI to write `signals.json` directly with one `refined-ticket` signal.',
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
    priorProgress: {
      placeholder: 'PRIOR_PROGRESS',
      description: 'Current `progress.md` body — empty when the sprint journal has no entries yet.',
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
  },
  expectedSignals: ['refined-ticket'],
};

/** Render a {@link Ticket} into the markdown block the refine template's `{{TICKET}}` slot expects. */
export const renderTicket = (ticket: Ticket): string => {
  const lines: string[] = [`**Title:** ${ticket.title}`, `**ID:** ${String(ticket.id)}`];
  if (ticket.link !== undefined) lines.push(`**Link:** ${ticket.link}`);
  if (ticket.description !== undefined && ticket.description.trim().length > 0) {
    lines.push('', '**Description:**', '', ticket.description.trim());
  }
  return lines.join('\n');
};

/**
 * Render the optional issue-context block. Pre-fetched body wins over a bare link; either way
 * the body is wrapped in `<context>...</context>` so the AI sees a consistent shape. When the
 * ticket has no link and no fetched body, returns an empty string and the template's
 * placeholder collapses (the surrounding markdown stays clean).
 */
export const renderIssueContextSection = (ticket: Ticket, fetched: string | undefined): string => {
  if (fetched !== undefined && fetched.trim().length > 0) {
    return `<context>\n\n${fetched.trim()}\n\n</context>`;
  }
  if (ticket.link !== undefined) {
    return `<context>\n\nUpstream issue: ${ticket.link}\n\n</context>`;
  }
  return '';
};

/** Top-level builder — accepts domain types, renders them into params, calls `buildPrompt`. */
export const buildRefinePrompt = async (
  deps: TemplateLoader,
  input: {
    readonly ticket: Ticket;
    readonly outputContractSection: string;
    readonly issueContext?: string;
    /** Current `progress.md` body — inlined into the prompt's "## Prior progress" section. */
    readonly priorProgress: string;
  }
): Promise<Result<Prompt, BuildPromptError>> => {
  const issueContext = renderIssueContextSection(input.ticket, input.issueContext);
  return buildPrompt(deps, refinePromptDef, {
    ticket: renderTicket(input.ticket),
    outputContractSection: input.outputContractSection,
    priorProgress: input.priorProgress,
    ...(issueContext.length > 0 ? { issueContext } : {}),
  });
};
