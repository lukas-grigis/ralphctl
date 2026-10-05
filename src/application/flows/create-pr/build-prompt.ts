import type { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { normalizeRefs } from '@src/domain/value/external-ref.ts';
import type { BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import {
  buildCreatePrPrompt,
  renderIssueRefs,
  renderTicketSummary,
} from '@src/integration/ai/prompts/create-pr/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { generatePrContentOutputContract } from '@src/application/flows/create-pr/leaves/generate-pr-content.contract.ts';

export interface CreatePrPromptSource {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly unitRoot: AbsolutePath;
  /** The repository the AI inspects; the same path the leaf grants as an additional root. */
  readonly repoPath: AbsolutePath;
}

/** Single builder for the create-pr prompt, shared by `render-prompt-to-file` and the authoring leaf. */
export const buildCreatePrPromptFromCtx = async (
  templateLoader: TemplateLoader,
  source: CreatePrPromptSource
): Promise<Result<Prompt, BuildPromptError>> => {
  const { sprint, tasks } = source;
  // Pre-computed `Closes <ref>` lines keep the trailing refs deterministic rather than AI-discovered.
  const refs = normalizeRefs([
    ...sprint.tickets.map((t) => t.externalRef ?? ''),
    ...tasks.flatMap((t) => t.externalRefs ?? []),
  ]);
  const tickets = sprint.tickets.map((t) => ({
    title: t.title,
    ...(t.link !== undefined ? { link: String(t.link) } : {}),
  }));
  return buildCreatePrPrompt(templateLoader, {
    baseBranch: source.baseBranch,
    headBranch: source.headBranch,
    repositoryPath: String(source.repoPath),
    ticketSummary: renderTicketSummary(tickets),
    issueRefs: renderIssueRefs(refs),
    outputContractSection: renderContractSectionFor(generatePrContentOutputContract, source.unitRoot),
  });
};
