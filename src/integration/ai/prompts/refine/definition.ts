import { type Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { requireNonEmpty } from '@src/integration/ai/prompts/_engine/validators.ts';

/**
 * Pre-rendered string parameters for the refine template. `ticket` and `issueContext` are
 * markdown blocks the AI reads to orient the interview. The interactive session reads
 * `prompt.md` (rendered from this template), interviews the operator, then writes a single
 * `refined-ticket` signal — carrying the approved requirements markdown in its `body` field —
 * to `signals.json` in its output directory. The harness reads and validates that file, not
 * a free-form output path.
 */
export interface RefinePromptParams {
  /** Markdown block describing the ticket (title, id, link, description). */
  readonly ticket: string;
  /** Optional `<context>...</context>` block with the upstream issue body or bare link. */
  readonly issueContext?: string;
  /**
   * Output contract section — rendered from the refine `AiOutputContract` by
   * `renderContractSectionFor(refineOutputContract)`. Tells the AI to write `signals.json`
   * directly with one `refined-ticket` signal whose `body` carries the requirements markdown.
   */
  readonly outputContractSection: string;
  /**
   * Current body of `progress.md` substituted into the `## Prior progress on this sprint`
   * section. Empty when the journal has no entries yet.
   */
  readonly priorProgress: string;
}

export const refinePromptDef: PromptDefinition<RefinePromptParams> = {
  templateName: 'refine',
  description:
    'Interactive requirements refinement for one pending ticket. The AI interviews the user, then writes the approved markdown requirements as a `refined-ticket` signal in `signals.json`.',
  parameters: {
    ticket: {
      placeholder: 'TICKET',
      description: 'Markdown block rendering the ticket title, id, link (when set), and description (when set).',
      validate: requireNonEmpty('ticket', 'rendered ticket block must not be empty'),
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
        'Output contract block rendered from the refine contract — instructs the AI to write `signals.json` directly with one `refined-ticket` signal.',
      validate: requireNonEmpty('outputContractSection', 'output-contract section must not be empty'),
    },
    priorProgress: {
      placeholder: 'PRIOR_PROGRESS',
      description: 'Current `progress.md` body — empty when the sprint journal has no entries yet.',
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
  },
  expectedSignals: ['refined-ticket', 'note', 'learning', 'decision'],
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
