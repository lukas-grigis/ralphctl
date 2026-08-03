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
import { aiUnitEpilogue, aiUnitPrelude } from '@src/application/flows/_shared/ai-unit-segment.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';
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
  /**
   * Provider id attributed on the AI sub-chain's `meta.json` sidecar (`'claude-code'` /
   * `'github-copilot'` / `'openai-codex'`). Optional so existing callers that construct this
   * flow without threading `settings.ai.createPr.provider` through still compile; omitting it
   * degrades the sidecar's `provider` field to `'unknown'` rather than failing the run.
   */
  readonly providerId?: string;
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
 *     install-skills,                 // copy the createPr flow's skills into the unit root
 *     stamp-meta-create-pr,           // <unit-root>/meta.json — provider/model attribution
 *     generate-pr-content,            // headless AI authoring → ctx.aiContent
 *     uninstall-skills,               // remove them again (skipped if an abort short-circuits)
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
    const unitOpts = {
      unitName: 'create-pr',
      flowId: 'createPr' as const,
      // Per-sprint unit root: `<sprintDir>/create-pr/<run-slug>/` — same layout the implement
      // / refine / plan flows use, so the user's repo working tree never collects scratch
      // artifacts from a `ralphctl create-pr` run.
      parent: (ctx: CreatePrCtx) => {
        const parentDir = AbsolutePath.parse(join(String(ctx.input.sprintDir), 'create-pr'));
        if (!parentDir.ok) throw parentDir.error;
        return parentDir.value;
      },
      slug: (ctx: CreatePrCtx) => slugifyBranch(ctx.headBranch ?? 'unknown-branch'),
      buildPrompt: async (ctx: CreatePrCtx) => {
        const currentUnitRoot = assertCtxField(ctx, 'currentUnitRoot', 'render-prompt-to-file', 'pre-render-prompt');
        const sprint = assertCtxField(ctx, 'sprint', 'render-prompt-to-file', 'pre-render-prompt');
        const tickets = sprint.tickets.map((t) => ({
          title: t.title,
          ...(t.link !== undefined ? { link: String(t.link) } : {}),
        }));
        const tasks = ctx.tasks ?? [];
        const refs = normalizeRefs([
          ...sprint.tickets.map((t) => t.externalRef ?? ''),
          ...tasks.flatMap((t) => t.externalRefs ?? []),
        ]);
        return buildCreatePrPrompt(deps.templateLoader, {
          baseBranch: ctx.input.base,
          headBranch: ctx.headBranch ?? '',
          ticketSummary: renderTicketSummary(tickets),
          issueRefs: renderIssueRefs(refs),
          outputContractSection: renderContractSectionFor(generatePrContentOutputContract, currentUnitRoot),
        });
      },
      // create-pr does not yet thread `settings.ai.createPr.provider` through as a plain string
      // (see `CreateCreatePrFlowOpts.providerId` doc) — falls back to a placeholder rather than
      // failing the sidecar write.
      providerId: opts.providerId ?? 'unknown',
      model: deps.model,
    } satisfies Parameters<typeof aiUnitPrelude<CreatePrCtx>>[1];

    children.push(
      createLoadCreatePrContextLeaf(deps),
      ...aiUnitPrelude<CreatePrCtx>(
        {
          writeFile: deps.writeFile,
          skillsAdapter: deps.skillsAdapter,
          skillSource: deps.skillSource,
          clock: deps.clock,
        },
        unitOpts
      ),
      generatePrContentLeaf({
        provider: deps.provider,
        templateLoader: deps.templateLoader,
        writeFile: deps.writeFile,
        eventBus: deps.eventBus,
        logger: deps.logger,
        model: deps.model,
      }),
      ...aiUnitEpilogue<CreatePrCtx>({ skillsAdapter: deps.skillsAdapter }, unitOpts)
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
