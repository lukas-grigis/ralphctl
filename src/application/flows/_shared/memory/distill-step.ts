import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Slug } from '@src/domain/value/slug.ts';
import type { AiSettings } from '@src/domain/entity/settings.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import { checkAborted, type Element, type ElementResult } from '@src/application/chain/element.ts';
import type { Trace } from '@src/application/chain/trace.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import {
  createDistillLearningsSubChain,
  type DistillLearningsDeps,
} from '@src/application/flows/_shared/memory/distill-learnings.ts';
import type { DistillLearningsCtx } from '@src/application/flows/_shared/memory/distill-ctx.ts';

/**
 * The minimum host-ctx shape the distill step reads. The close-sprint / review ctxs satisfy this
 * with a single `distillRequested` flag — they are NOT widened with `entries` /
 * `candidates` / `acceptedIds`; the distill sub-chain carries its own {@link DistillLearningsCtx}
 * internally.
 */
export interface DistillRequestedCtx {
  /** Opt-in gate. `true` → run the distill sub-chain; `false` → its `distill-gate` guard skips. */
  readonly distillRequested: boolean;
}

/**
 * Static distill inputs the host flow resolves at launch time — everything the sub-chain needs
 * that does NOT vary across the host ctx. The host ctx only contributes `distillRequested`.
 */
export interface DistillStepOpts {
  /** Project whose learnings ledger is read — `<memoryRoot>/<projectId>--<projectSlug>/learnings.ndjson`. */
  readonly projectId: ProjectId;
  /** Project slug — builds the human-readable `<id>--<slug>/` ledger subdirectory (direct-build). */
  readonly projectSlug: Slug;
  /** Storage root for the per-project learnings ledger (`<dataRoot>/memory`). */
  readonly memoryRoot: AbsolutePath;
  /** Per-provider sandbox root under which each provider's prompt + output file round-trip. */
  readonly distillRoot: AbsolutePath;
  /** Repository whose native context files the distilled learnings fold into. */
  readonly repository: Repository;
  /** Flat AI settings — drives the per-provider fan-out + model / effort selection. */
  readonly ai: AiSettings;
}

/**
 * Self-contained distill SUB-RUNNER — the adapter step that composes the distill
 * sub-chain into the close-sprint and review flows. It is a thin `Element<TCtx>` over the host
 * (close / review) ctx that, at execute time:
 *
 *  1. maps the host ctx → a fresh {@link DistillLearningsCtx} (`distillRequested` + the static
 *     `repository`, with an empty `entries` slate);
 *  2. builds {@link createDistillLearningsSubChain} from the same `deps` + `opts`; and
 *  3. runs it through a NESTED {@link createRunner} wired to the SAME outer `AbortSignal`.
 *
 * A nested runner inside an element is NOT a sixth chain primitive — it's an adapter
 * that lets BOTH close paths (close-sprint's explicit close + review's auto-done) reuse one distill
 * implementation without widening their ctxs with the distill-local shape.
 *
 * Error semantics:
 *  - **AbortError propagates transparently.** The distill runs while the sprint is still `review`,
 *    so a mid-distill Ctrl+C must leave the sprint un-closed and the run re-runnable. When the
 *    nested runner reports `aborted` (or the build/run surfaces an `Aborted`-coded error), this
 *    step returns `Result.error` with an `AbortError` so the host chain skips the transition leaf.
 *  - **A non-abort distill failure is best-effort.** Distill is opt-in enrichment, and any
 *    unpromoted learnings remain in the ledger for a future sprint's distill — so a failed AI
 *    session / write / build is logged at `warn` level and the step returns `Result.ok` to let the
 *    host flow CONTINUE to the transition. The fallback that absorbs non-abort errors exempts
 *    `AbortError` (it is re-raised, never swallowed).
 *
 * @public
 */
export const createDistillStep = <TCtx extends DistillRequestedCtx>(
  deps: DistillLearningsDeps,
  opts: DistillStepOpts,
  name = 'distill-learnings-step'
): Element<TCtx> => ({
  name,
  async execute(ctx, signal, onTrace): Promise<ElementResult<TCtx>> {
    // Honour an abort that already tripped before we start — symmetric with every primitive.
    const aborted = checkAborted<TCtx>(name, signal, onTrace);
    if (aborted) return aborted;

    const log = deps.logger.named('memory.distill-step');

    const subChain = createDistillLearningsSubChain(deps, {
      projectId: opts.projectId,
      projectSlug: opts.projectSlug,
      memoryRoot: opts.memoryRoot,
      distillRoot: opts.distillRoot,
      ai: opts.ai,
    });
    if (!subChain.ok) {
      // Build-time failure (e.g. an invalid ledger path) is a non-abort error — best-effort:
      // log + continue so the sprint still closes. Unpromoted learnings stay in the ledger.
      log.warn('distill sub-chain build failed; continuing to close without distilling', {
        error: subChain.error.message,
      });
      return Result.ok({ ctx, trace: [] });
    }

    const initialCtx: DistillLearningsCtx = {
      distillRequested: ctx.distillRequested,
      repository: opts.repository,
      entries: {},
    };

    const runner = createRunner<DistillLearningsCtx>({ id: name, element: subChain.value, initialCtx });

    // Forward the outer signal into the nested runner so a Ctrl+C during distill aborts the
    // inner chain too. `runner.abort()` is idempotent; if the signal already fired we handled it
    // above, so this only bridges a mid-run abort.
    const onAbort = (): void => runner.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    // Forward every nested trace entry up to the host's `onTrace` so the TUI rail and the durable
    // chain.log see the distill sub-chain's steps inline with the close / review flow.
    const unsubscribe = runner.subscribe((event) => {
      if (event.type === 'step') onTrace?.(event.entry);
    });

    try {
      await runner.start();
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }

    const subTrace = [...runner.trace];

    if (runner.status === 'aborted') {
      // AbortError forwards transparently — the host chain's sequential aborts the remainder, so
      // the transition leaf never runs and the sprint stays `review` (re-runnable).
      const error = new AbortError({ elementName: name, reason: 'distill aborted' });
      return Result.error({ error, trace: subTrace });
    }

    if (runner.status === 'failed') {
      // Best-effort: a non-abort distill failure does NOT block the close. The nested runner only
      // reaches `failed` on a non-abort `DomainError` (it routes `Aborted`-coded errors to
      // `aborted` above), so this branch is already AbortError-exempt by construction.
      log.warn('distill failed; continuing to close without promoting learnings', {
        error: failureMessage(runner.trace),
      });
      return Result.ok({ ctx, trace: subTrace });
    }

    // Completed (or skipped via the gate when distillRequested === false) — continue unchanged.
    return Result.ok({ ctx, trace: subTrace });
  },
});

/**
 * Pull a human-readable message off the last failing trace entry — used only for the best-effort
 * warn log. Defaults to a generic string when no error entry is present (shouldn't happen on a
 * `failed` runner, but the log line must never throw).
 */
const failureMessage = (trace: Trace): string => {
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const error = trace[i]?.error;
    if (error !== undefined && error.code !== ErrorCode.Aborted) return error.message;
  }
  return 'distill failed (no error detail in trace)';
};
