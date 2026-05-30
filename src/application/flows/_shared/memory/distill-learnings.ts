import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { uniqueProvidersFromAi, type AiProvider, type AiSettings } from '@src/domain/entity/settings.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { RunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { toolForProvider, type AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { guard } from '@src/application/chain/build/guard.ts';
import { learningsLedgerPath } from '@src/application/flows/_shared/memory/ledger-path.ts';
import { loadLearningsLeaf } from '@src/application/flows/_shared/memory/load-learnings.ts';
import { stampPromotedLeaf } from '@src/application/flows/_shared/memory/stamp-promoted.ts';
import { distillProposeLeaf } from '@src/application/flows/_shared/memory/distill-propose.ts';
import { distillConfirmLeaf } from '@src/application/flows/_shared/memory/distill-confirm.ts';
import { distillWriteLeaf } from '@src/application/flows/_shared/memory/distill-write.ts';
import type { DistillLearningsCtx } from '@src/application/flows/_shared/memory/distill-ctx.ts';

/**
 * Slim dependency contract for the self-contained distill sub-chain — the subset of `AppDeps` the
 * sub-chain needs. The host flow (close-sprint / review) constructs these from the
 * composition root and hands them to {@link createDistillLearningsSubChain}.
 *
 *  - `interactiveAiFor` — per-provider interactive AI adapter factory. The distill prompt is a
 *    full-file write-back (the AI writes the COMPLETE updated context file to its output file), so
 *    it rides the interactive port like plan / refine, NOT the headless signals contract. Called
 *    once per distinct provider in `opts.ai`.
 *  - `runInTerminal` — pause-the-TUI wrapper so the interactive session owns the terminal.
 *  - `templateLoader` — renders the `distill-learnings` prompt.
 *  - `interactive` — the human-gate prompt port (confirm before each write).
 *  - `writeFile` — atomic {@link WriteFile} port for the native context file + its `.bak` backup.
 *  - `logger` — structured logging shared with the load / stamp leaves.
 *  - `clock` — injected so tests pin the backup-file timestamp suffix and the `promotedAt` stamp.
 */
export interface DistillLearningsDeps {
  readonly interactiveAiFor: (provider: AiProvider) => InteractiveAiProvider;
  readonly runInTerminal: RunInTerminal;
  readonly templateLoader: TemplateLoader;
  readonly interactive: InteractivePrompt;
  readonly writeFile: WriteFile;
  readonly logger: Logger;
  readonly clock: () => IsoTimestamp;
}

export interface CreateDistillLearningsOpts {
  /** Project whose learnings ledger is read — `<memoryRoot>/<projectId>/learnings.ndjson`. */
  readonly projectId: ProjectId;
  /** Storage root for the per-project learnings ledger (`<dataRoot>/memory`). */
  readonly memoryRoot: AbsolutePath;
  /**
   * Per-provider sandbox root under which each distinct provider's prompt + output file
   * round-trip (`<distillRoot>/<tool>/...`). The host flow allocates this under the sprint dir.
   */
  readonly distillRoot: AbsolutePath;
  /**
   * Flat AI settings — the sub-chain derives the unique provider set from these per-flow rows and
   * writes one native context file per distinct provider, and picks each provider's model / effort.
   */
  readonly ai: AiSettings;
}

/**
 * Resolve the model + effort for one provider from the flat AI settings. Walks the per-flow rows
 * and returns the first whose provider matches — distillation is provider-keyed, not flow-keyed,
 * so any row referencing the provider is a valid source for the model.
 */
const pickModelEffortForProvider = (
  ai: AiSettings,
  provider: AiProvider
): { readonly model: string; readonly effort?: string } => {
  const rows = [
    ai.refine,
    ai.plan,
    ai.implement.generator,
    ai.implement.evaluator,
    ai.readiness,
    ai.ideate,
    ai.createPr,
  ];
  for (const row of rows) {
    if (row.provider === provider) {
      const effort = row.effort ?? ai.effort;
      return effort !== undefined ? { model: row.model, effort } : { model: row.model };
    }
  }
  // Caller derives the provider list from these same rows; unreachable.
  throw new Error(`pickModelEffortForProvider: provider ${provider} not referenced in ai settings`);
};

/**
 * Build one distinct provider's distill segment: a SEQUENTIAL sub-chain
 * `propose → confirm → write` over the shared distill-local ctx. Each segment writes exactly one
 * native context file for the provider's tool (`CLAUDE.md` / `.github/copilot-instructions.md` /
 * `AGENTS.md`) — one real file per provider, never a symlink (§10).
 */
const buildPerProviderSegment = (
  deps: DistillLearningsDeps,
  opts: CreateDistillLearningsOpts,
  provider: AiProvider,
  tool: AssistantTool
): Element<DistillLearningsCtx> => {
  const { model, effort } = pickModelEffortForProvider(opts.ai, provider);
  return sequential<DistillLearningsCtx>(`distill-tool-${tool}`, [
    distillProposeLeaf(
      {
        interactiveAi: deps.interactiveAiFor(provider),
        runInTerminal: deps.runInTerminal,
        templateLoader: deps.templateLoader,
        logger: deps.logger,
        model,
        ...(effort !== undefined ? { effort } : {}),
        distillRoot: opts.distillRoot,
      },
      tool
    ),
    distillConfirmLeaf({ interactive: deps.interactive }, tool),
    distillWriteLeaf({ writeFile: deps.writeFile, logger: deps.logger, clock: deps.clock }, tool),
  ]);
};

/**
 * Build the SELF-CONTAINED distill sub-chain — a reusable factory composed
 * from `sequential` + `guard` + `leaf` ONLY (§14 five-primitive rule — no `retry` around the AI
 * spawn; retry-on-429 is an adapter concern). It runs over its OWN {@link DistillLearningsCtx} and
 * uses its OWN propose / confirm / write leaves, so composing it into the close-sprint and review
 * flows widens only their ctxs with a single `distillRequested` flag — the readiness leaf
 * surface stays untouched.
 *
 * Shape:
 *
 *   guard('distill-gate', ctx => ctx.distillRequested === true,
 *     sequential('distill-learnings', [
 *       load-learnings,                          // read the project ledger ONCE (shared candidates)
 *       // one SEQUENTIAL segment per DISTINCT provider in opts.ai (order follows FLOW_IDS):
 *       sequential('distill-tool-claude-code', [ propose → confirm → write ]),
 *       sequential('distill-tool-copilot',    [ … ]),
 *       sequential('distill-tool-codex',      [ … ]),
 *       stamp-promoted,                          // mark accepted candidates promoted AFTER writes
 *     ]))
 *
 * Behaviour:
 *  - `distill-gate` SKIPS the entire body when `distillRequested === false` — no ledger read, no
 *    AI session, no file touch. The guard emits a single `skipped` trace entry for the body.
 *  - Per-provider fan-out is a SEQUENTIAL list of per-tool segments (NOT a parallel fan-out — the
 *    rejected pattern). One native context file is written per distinct provider (§10), AI
 *    proposes → operator confirms → harness writes with a `.bak.<iso>` backup.
 *  - `stamp-promoted` runs LAST. An `AbortError` mid-distill forwards verbatim through the
 *    sequential sub-chain, which then skips the stamp — so a cancelled distill leaves the ledger
 *    UN-stamped and the learnings re-runnable.
 *
 * @public
 */
export const createDistillLearningsSubChain = (
  deps: DistillLearningsDeps,
  opts: CreateDistillLearningsOpts
): Result<Element<DistillLearningsCtx>, ValidationError> => {
  const ledgerPath = learningsLedgerPath(opts.memoryRoot, String(opts.projectId));
  if (!ledgerPath.ok) return Result.error(ledgerPath.error);
  const path = ledgerPath.value;

  const providers = uniqueProvidersFromAi(opts.ai);
  const perProviderSegments = providers.map((provider) =>
    buildPerProviderSegment(deps, opts, provider, toolForProvider(provider))
  );

  const stampPromoted = stampPromotedLeaf<DistillLearningsCtx>(
    { writeFile: deps.writeFile, logger: deps.logger, clock: deps.clock },
    {
      path: () => path,
      acceptedIds: (ctx) => ctx.acceptedIds ?? [],
      output: (ctx) => ctx,
    }
  );

  const body = sequential<DistillLearningsCtx>('distill-learnings', [
    loadLearningsLeaf<DistillLearningsCtx>(
      { logger: deps.logger },
      { path: () => path, output: (ctx, candidates) => ({ ...ctx, candidates }) }
    ),
    // An empty / absent ledger leaves `ctx.candidates` empty. Skip the per-provider fold AND the
    // stamp in that case: the distill prompt's `CANDIDATE_LEARNINGS` placeholder requires a
    // non-empty value, so spawning the AI on zero candidates would only fail and emit a spurious
    // "distill failed" warn. The guard emits a clean `skipped` trace instead — no AI spawn.
    guard<DistillLearningsCtx>(
      'distill-has-candidates',
      (ctx) => (ctx.candidates?.length ?? 0) > 0,
      sequential<DistillLearningsCtx>('distill-fold', [...perProviderSegments, stampPromoted])
    ),
  ]);

  return Result.ok(guard<DistillLearningsCtx>('distill-gate', (ctx) => ctx.distillRequested === true, body));
};
