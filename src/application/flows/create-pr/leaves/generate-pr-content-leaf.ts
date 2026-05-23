import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { normalizeRefs } from '@src/domain/value/external-ref.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { PrContentSignal } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import {
  buildCreatePrPrompt,
  renderIssueRefs,
  renderTicketSummary,
} from '@src/integration/ai/prompts/create-pr/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { renderSidecars } from '@src/integration/ai/contract/_engine/render-sidecars.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';

import type { CreatePrCtx } from '@src/application/flows/create-pr/ctx.ts';
import { generatePrContentOutputContract } from '@src/application/flows/create-pr/leaves/generate-pr-content.contract.ts';

/**
 * Permission profile for the create-pr authoring spawn. The AI needs `git log` / `git diff`
 * (canRunShell: true) to derive context from the actual diff; it must NOT modify repo files
 * (canModifyRepoFiles: false — the branch is already pushed, the diff is the source of
 * truth); network is denied since the prompt is self-contained. Topology constrains the AI
 * further — the repo is mounted via `additionalRoots` (read for git access), the unit dir
 * is the only writable root (auto-included as outputDir per `resolveWritableRoots`).
 */
const PR_AUTHORING_PERMISSIONS = {
  canModifyRepoFiles: false,
  canRunShell: true,
  canAccessNetwork: false,
  autoApprove: true,
} as const;

export interface GeneratePrContentLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  /**
   * Output port used to write `pr-content.md` post-spawn under audit-[09]. The AI writes
   * `signals.json` directly into the unit dir; the leaf validates that file and renders
   * sidecars from the validated signals.
   */
  readonly writeFile: WriteFile;
  /**
   * Application bus — the validated `pr-content` signal fans out as a typed `ai-signal`
   * event the TUI can subscribe to.
   */
  readonly eventBus: EventBus;
  readonly logger: Logger;
  /** Per-spawn model — picked by the flow factory from settings. */
  readonly model: string;
}

interface GeneratePrContentInput {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly unitRoot: AbsolutePath;
  readonly promptFile: AbsolutePath;
  /**
   * Repo path — mounted via `additionalRoots` so the headless session can run `git log` /
   * `git diff` against it. Sourced from `ctx.input.cwd`. The cwd stays the unit dir so the
   * repo's `CLAUDE.md` / `AGENTS.md` is not auto-loaded (this is summarisation work, not
   * engineering work; we want a neutral session root).
   */
  readonly repoPath: AbsolutePath;
}

interface GeneratePrContentOutput {
  /** Validated AI proposal, or `undefined` when the leaf fell back. Downstream picks template-derived content. */
  readonly aiContent?: { readonly title: string; readonly body: string };
}

/**
 * Headless AI authoring of the pull-request title + body. Optional in the create-pr flow:
 * any failure (offline, missing creds, spawn timeout, schema mismatch, sidecar write error)
 * degrades gracefully — the leaf still returns `Result.ok` with `aiContent` left undefined,
 * the downstream create-pr leaf then falls back to the template-derived content from
 * `derivePrContent`. Opening a PR is never blocked by the AI step.
 *
 * Exception: `AbortError` propagates transparently per CLAUDE.md. User-initiated cancellation
 * must not be absorbed by the fallback.
 *
 * Session topology:
 *   cwd            = `<sprintDir>/create-pr/<run-slug>/` (neutral root — not the repo, so
 *                    the repo's CLAUDE.md / AGENTS.md / .mcp.json is not auto-loaded; this
 *                    is summarisation, not engineering)
 *   additionalRoots = [repoPath] so the AI can run `git log` / `git diff` against the repo
 *   outputDir      = `<sprintDir>/create-pr/<run-slug>/` (auto-included as writable)
 */
export const generatePrContentLeaf = (deps: GeneratePrContentLeafDeps): Element<CreatePrCtx> =>
  leaf<CreatePrCtx, GeneratePrContentInput, GeneratePrContentOutput>('generate-pr-content', {
    useCase: {
      execute: async (input) => {
        // Derive verbatim `Closes <ref>` lines from ticket + task externalRefs — the prompt
        // embeds the rendered string and instructs the AI to mirror it at the bottom of the
        // body. Pre-computing here keeps the trailing refs deterministic instead of relying
        // on the AI to discover and order them.
        const refs = normalizeRefs([
          ...input.sprint.tickets.map((t) => t.externalRef ?? ''),
          ...input.tasks.flatMap((t) => t.externalRefs ?? []),
        ]);

        const ticketSummary = renderTicketSummary(
          input.sprint.tickets.map((t) => ({
            title: t.title,
            ...(t.link !== undefined ? { link: String(t.link) } : {}),
          }))
        );
        const issueRefs = renderIssueRefs(refs);

        const promptResult = await buildCreatePrPrompt(deps.templateLoader, {
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          ticketSummary,
          issueRefs,
          outputContractSection: renderContractSectionFor(generatePrContentOutputContract, input.unitRoot),
        });
        if (!promptResult.ok) {
          deps.logger
            .named('create-pr.ai')
            .warn(
              `create-pr: AI authoring skipped — prompt build failed: ${promptResult.error.message}; falling back to template`
            );
          return Result.ok({});
        }

        const writePrompt = await deps.writeFile(input.promptFile, String(promptResult.value));
        if (!writePrompt.ok) {
          deps.logger
            .named('create-pr.ai')
            .warn(
              `create-pr: AI authoring skipped — prompt file write failed: ${writePrompt.error.message}; falling back to template`
            );
          return Result.ok({});
        }

        // The signalsFile path mirrors the audit-[09] convention: <outputDir>/signals.json.
        const signalsFilePathResult = AbsolutePath.parse(`${String(input.unitRoot)}/signals.json`);
        if (!signalsFilePathResult.ok) {
          deps.logger
            .named('create-pr.ai')
            .warn(
              `create-pr: AI authoring skipped — could not resolve signals.json path: ${signalsFilePathResult.error.message}; falling back to template`
            );
          return Result.ok({});
        }

        const session: AiSession = {
          prompt: promptResult.value,
          cwd: input.unitRoot,
          additionalRoots: [input.repoPath],
          model: deps.model,
          permissions: PR_AUTHORING_PERMISSIONS,
          signalsFile: signalsFilePathResult.value,
          outputDir: input.unitRoot,
        };

        try {
          const spawn = await deps.provider.generate(session);
          if (!spawn.ok) {
            deps.logger
              .named('create-pr.ai')
              .warn(`create-pr: AI authoring failed, falling back to template (${spawn.error.message})`);
            return Result.ok({});
          }

          const validated = await validateSignalsFile(input.unitRoot, generatePrContentOutputContract);
          if (!validated.ok) {
            deps.logger
              .named('create-pr.ai')
              .warn(`create-pr: AI authoring failed, falling back to template (${validated.error.message})`);
            return Result.ok({});
          }
          const signals = validated.value;

          // Fan out the validated signal to the application bus so TUI subscribers see the
          // proposal live. The contract guarantees exactly one pr-content signal — narrative
          // kinds are not part of the contract for this leaf.
          for (const sig of signals) {
            deps.eventBus.publish({ type: 'ai-signal', signal: sig, source: 'create-pr' });
          }

          // Render harness-owned sidecar `pr-content.md`. Write failures inside renderSidecars
          // log warn and the helper still returns ok — the operator file is convenience only.
          await renderSidecars(
            deps.writeFile,
            input.unitRoot,
            signals,
            generatePrContentOutputContract.sidecars,
            deps.logger
          );

          const prContent = signals.find((s): s is PrContentSignal => s.type === 'pr-content');
          if (prContent === undefined) {
            // Defensive — the contract's exactlyOne refine should have caught this upstream.
            deps.logger
              .named('create-pr.ai')
              .warn('create-pr: validated signals missing pr-content despite schema — falling back to template');
            return Result.ok({});
          }

          return Result.ok({ aiContent: { title: prContent.title, body: prContent.body } });
        } catch (err) {
          // AbortError MUST propagate per CLAUDE.md — user-initiated cancellation flows
          // through every wrapper without being absorbed by guards or fallbacks.
          if (err instanceof AbortError) throw err;
          deps.logger
            .named('create-pr.ai')
            .warn(
              `create-pr: AI authoring failed, falling back to template (${err instanceof Error ? err.message : String(err)})`
            );
          return Result.ok({});
        }
      },
    },
    input: (ctx) => {
      if (ctx.currentUnitRoot === undefined || ctx.currentPromptFile === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-generate-pr-content',
          attemptedAction: 'generate-pr-content',
          message:
            'generate-pr-content: unit root / prompt file missing — build-create-pr-unit + render-prompt-to-file must run first',
        });
      }
      if (ctx.sprint === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-generate-pr-content',
          attemptedAction: 'generate-pr-content',
          message: 'generate-pr-content: ctx.sprint is undefined — load-sprint must run first',
        });
      }
      return {
        sprint: ctx.sprint,
        tasks: ctx.tasks ?? [],
        baseBranch: ctx.input.base,
        headBranch: ctx.headBranch ?? '',
        unitRoot: ctx.currentUnitRoot,
        promptFile: ctx.currentPromptFile,
        repoPath: ctx.input.cwd,
      };
    },
    output: (ctx, out) => (out.aiContent !== undefined ? { ...ctx, aiContent: out.aiContent } : ctx),
  });
