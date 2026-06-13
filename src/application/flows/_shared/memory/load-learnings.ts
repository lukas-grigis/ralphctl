import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import { isAbortedRead } from '@src/application/flows/_shared/memory/abort-guard.ts';
import { readLedgerLines } from '@src/application/flows/_shared/memory/read-ledger.ts';

const LEAF_NAME = 'load-learnings';

export interface LoadLearningsLeafDeps {
  readonly logger: Logger;
}

/**
 * Pure ctx contract for {@link loadLearningsLeaf}. The flow author wires the ledger path in (the
 * leaf does not resolve `<memoryRoot>/<projectId>/...` itself — see `learningsLedgerPath`), reads
 * the result back, and may map a read failure however the surrounding flow needs.
 */
export interface LoadLearningsLeafConfig<TCtx> {
  /** Resolve the absolute ledger path at execute time. */
  readonly path: (ctx: TCtx) => AbsolutePath;
  /** Merge the loaded, de-duplicated, not-yet-promoted candidate learnings into ctx. */
  readonly output: (ctx: TCtx, candidates: readonly LearningRecord[]) => TCtx;
}

/**
 * READ side of the procedural-memory learnings pipeline. Loads the project's append-only NDJSON ledger,
 * de-dups by record `id` (keeping the FIRST occurrence — the write side stamps a stable
 * `deriveLearningId` id, `sha1(repo|taskKind|normalize(text))[:16]`, so a re-emitted learning
 * collapses onto one row), and filters to
 * the records still awaiting promotion (`promotedAt === null`). Those are the candidates the
 * distill flow proposes to the operator.
 *
 * Two non-fatal read outcomes BOTH resolve to "propose nothing" (an empty candidate list):
 *  - the ledger file is ABSENT (`ENOENT`) — the project never produced a learning yet;
 *  - any other read error — a missing ledger must never block closing a sprint.
 *
 * CRITICAL (AbortError): the "no ledger → propose nothing" fallback re-checks the read error and
 * re-propagates a cancelled read as `AbortError` (`code === 'aborted'`). A user pressing Ctrl+C
 * mid-read must NOT be silently swallowed into an empty ledger — that would let the distill flow
 * proceed as if there were nothing to promote. `AbortError` is the one error chains forward
 * transparently, so it surfaces here verbatim.
 *
 * Malformed individual lines are skipped (logged warn) rather than failing the whole load — one
 * corrupt row should not orphan every other learning in the ledger.
 *
 * @public
 */
export const loadLearningsLeaf = <TCtx>(
  deps: LoadLearningsLeafDeps,
  config: LoadLearningsLeafConfig<TCtx>
): Element<TCtx> =>
  leaf<TCtx, { readonly path: AbsolutePath }, readonly LearningRecord[]>(LEAF_NAME, {
    useCase: {
      execute: async (input, signal) => loadCandidates(deps, input.path, signal),
    },
    input: (ctx) => ({ path: config.path(ctx) }),
    output: (ctx, candidates) => config.output(ctx, candidates),
  });

const loadCandidates = async (
  deps: LoadLearningsLeafDeps,
  path: AbsolutePath,
  signal: AbortSignal | undefined
): Promise<Result<readonly LearningRecord[], DomainError>> => {
  const log = deps.logger.named('memory.load-learnings');

  const candidates: LearningRecord[] = [];
  const seen = new Set<string>();
  try {
    // Read the whole ledger and process it. An absent ledger (ENOENT) reads as an empty list, so
    // the candidate list is simply empty. A pathologically-huge file is rotated aside by the reader
    // and likewise yields an empty list (see readLedgerLines' byte-ceiling guard).
    const lines = await readLedgerLines(path, log, signal);
    for (const { record, parseError } of lines) {
      if (parseError !== undefined) {
        log.warn('skipping malformed learnings.ndjson line', { error: parseError.message });
        continue;
      }
      if (record === undefined) continue; // blank line
      if (seen.has(record.id)) continue; // dedup by stable id, keep first
      seen.add(record.id);
      if (record.promotedAt !== null) continue; // already promoted — not a candidate
      candidates.push(record);
    }
  } catch (cause) {
    // CRITICAL: a cancelled read must re-propagate `Aborted`, never collapse into "empty ledger".
    if (isAbortedRead(cause, signal)) {
      return Result.error(new AbortError({ elementName: LEAF_NAME }));
    }
    // Any other stream failure → propose nothing. A missing ledger is the common case (the
    // project simply hasn't produced a learning); it must not block the flow.
    log.info('no learnings ledger — proposing nothing', { path: String(path) });
    return Result.ok([]);
  }

  log.info(`loaded ${candidates.length} candidate learning(s)`, { path: String(path), count: candidates.length });
  return Result.ok(candidates);
};
