import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';

import type { CreatePrCtx } from '@src/application/flows/create-pr/ctx.ts';
import type { CreatePrDeps } from '@src/application/flows/create-pr/deps.ts';
import { createPushBranchLeaf } from '@src/application/flows/create-pr/leaves/push-branch-leaf.ts';
import { createCreatePrLeaf } from '@src/application/flows/create-pr/leaves/create-pr-leaf.ts';
import { createLoadCreatePrContextLeaf } from '@src/application/flows/create-pr/leaves/load-create-pr-context-leaf.ts';
import { generatePrContentLeaf } from '@src/application/flows/create-pr/leaves/generate-pr-content-leaf.ts';
import { buildUnitLeaf } from '@src/application/flows/_shared/build-unit.ts';
import { renderPromptToFileLeaf } from '@src/application/flows/_shared/render-prompt-to-file.ts';
import {
  buildCreatePrPrompt,
  renderIssueRefs,
  renderTicketSummary,
} from '@src/integration/ai/prompts/create-pr/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { generatePrContentOutputContract } from '@src/application/flows/create-pr/leaves/generate-pr-content.contract.ts';
import { normalizeRefs } from '@src/domain/value/external-ref.ts';

export interface CreateCreatePrFlowOpts {
  /**
   * When `true` (default), splice the AI authoring sub-chain in front of the create-pr leaf
   * so the PR title + body come from a fresh AI session against the actual git diff. When
   * `false` (CLI `--no-ai`, TUI `a` toggle), the AI sub-chain is omitted and the create-pr
   * leaf falls back to `derivePrContent`'s template output.
   */
  readonly useAi?: boolean;
}

/**
 * Build the create-pr chain.
 *
 * Shape (useAi=true):
 *
 *   sequential('create-pr', [
 *     push-branch,                    // git push -u origin <sprint-branch>
 *     load-create-pr-context,         // hydrate sprint + tasks + headBranch onto ctx
 *     build-create-pr-unit,           // mkdir <sprintDir>/create-pr/<run-slug>/
 *     render-prompt-to-file,          // write prompt.md
 *     generate-pr-content,            // headless AI authoring → ctx.aiContent
 *     create-pr,                      // gh pr create / glab mr create + persist URL
 *   ])
 *
 * Shape (useAi=false):
 *
 *   sequential('create-pr', [
 *     push-branch,
 *     create-pr,
 *   ])
 *
 * The AI step is a flow-construction-time toggle (CLI flag / TUI hotkey), not a runtime
 * branch on ctx — imperative composition is cleaner than a `guard` predicate for an
 * absent/present sub-chain decision. Whichever shape is built, the create-pr leaf reads
 * `ctx.aiContent` and prefers it over template content when present; absent triggers
 * the template fallback.
 */
export const createCreatePrFlow = (deps: CreatePrDeps, opts: CreateCreatePrFlowOpts = {}): Element<CreatePrCtx> => {
  const useAi = opts.useAi ?? true;

  const children: Array<Element<CreatePrCtx>> = [createPushBranchLeaf(deps)];

  if (useAi) {
    children.push(
      createLoadCreatePrContextLeaf(deps),
      buildUnitLeaf<CreatePrCtx>({
        name: 'build-create-pr-unit',
        // Per-sprint unit root: `<sprintExecutionDir>/create-pr/<run-slug>/`. The flow does
        // not have access to the sprint dir directly; we derive it from the branch + sprintId
        // via a stable slug — one unit per branch so re-runs land in the same place.
        parent: (ctx) => {
          // The "sprint dir" convention is `<dataRoot>/sprints/<sprintId>/`. We don't have
          // that path on deps here; the load-context leaf doesn't carry it either. Place
          // the unit under the cwd's `.ralphctl-create-pr/<sprintId>/` so the leaf has a
          // deterministic writable path without coupling to the storage layout — the unit
          // dir is a per-run scratchpad, not a long-lived audit artefact.
          const sprintId = String(ctx.input.sprintId);
          const parentDir = AbsolutePath.parse(join(String(ctx.input.cwd), '.ralphctl-create-pr', sprintId));
          if (!parentDir.ok) throw parentDir.error;
          return parentDir.value;
        },
        slug: (ctx) => slugifyBranch(ctx.headBranch ?? 'unknown-branch'),
        write: (ctx, root) => {
          const promptPath = AbsolutePath.parse(join(String(root), 'prompt.md'));
          if (!promptPath.ok) throw promptPath.error;
          return { ...ctx, currentUnitRoot: root, currentPromptFile: promptPath.value };
        },
      }),
      renderPromptToFileLeaf<CreatePrCtx>(
        { writeFile: deps.writeFile },
        {
          name: 'render-prompt-to-file',
          path: (ctx) => {
            if (ctx.currentPromptFile === undefined) throw new Error('currentPromptFile missing');
            return ctx.currentPromptFile;
          },
          buildPrompt: async (ctx) => {
            if (ctx.currentUnitRoot === undefined) throw new Error('currentUnitRoot missing');
            if (ctx.sprint === undefined) throw new Error('ctx.sprint missing');
            const tickets = ctx.sprint.tickets.map((t) => ({
              title: t.title,
              ...(t.link !== undefined ? { link: String(t.link) } : {}),
            }));
            const tasks = ctx.tasks ?? [];
            const refs = normalizeRefs([
              ...ctx.sprint.tickets.map((t) => t.externalRef ?? ''),
              ...tasks.flatMap((t) => t.externalRefs ?? []),
            ]);
            return buildCreatePrPrompt(deps.templateLoader, {
              baseBranch: ctx.input.base,
              headBranch: ctx.headBranch ?? '',
              ticketSummary: renderTicketSummary(tickets),
              issueRefs: renderIssueRefs(refs),
              outputContractSection: renderContractSectionFor(generatePrContentOutputContract, ctx.currentUnitRoot),
            });
          },
          write: (ctx, path) => ({ ...ctx, currentPromptFile: path }),
        }
      ),
      generatePrContentLeaf({
        provider: deps.provider,
        templateLoader: deps.templateLoader,
        writeFile: deps.writeFile,
        eventBus: deps.eventBus,
        logger: deps.logger,
        model: deps.model,
      })
    );
  }

  children.push(createCreatePrLeaf(deps));

  return sequential<CreatePrCtx>('create-pr', children);
};

/**
 * Slugify a branch name so it can be used as a stable folder name. Replaces `/` and any
 * non-URL-safe characters; the AI leaf uses this for the per-spawn unit dir.
 */
const slugifyBranch = (branch: string): string =>
  branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'pr';
