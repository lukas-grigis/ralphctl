import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { type LearningRecord, parseLearningLine } from '@src/application/flows/_shared/memory/learning-record.ts';

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
 * READ side of the Theme 6 learnings pipeline. Loads the project's append-only NDJSON ledger,
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

  let raw: string;
  try {
    raw = await fs.readFile(String(path), { encoding: 'utf8', ...(signal ? { signal } : {}) });
  } catch (cause) {
    // CRITICAL: a cancelled read must re-propagate `Aborted`, never collapse into "empty ledger".
    if (isAbortedRead(cause, signal)) {
      return Result.error(new AbortError({ elementName: LEAF_NAME }));
    }
    // Absent ledger (or any other read failure) → propose nothing. A missing ledger is the
    // common case (the project simply hasn't produced a learning); it must not block the flow.
    log.info('no learnings ledger — proposing nothing', { path: String(path) });
    return Result.ok([]);
  }

  const candidates: LearningRecord[] = [];
  const seen = new Set<string>();
  const lines = raw.split('\n');
  for (const line of lines) {
    const parsed = parseLearningLine(line);
    if (!parsed.ok) {
      log.warn('skipping malformed learnings.ndjson line', { error: parsed.error.message });
      continue;
    }
    const record = parsed.value;
    if (record === undefined) continue; // blank line
    if (seen.has(record.id)) continue; // dedup by stable id, keep first
    seen.add(record.id);
    if (record.promotedAt !== null) continue; // already promoted — not a candidate
    candidates.push(record);
  }

  log.info(`loaded ${candidates.length} candidate learning(s)`, { path: String(path), count: candidates.length });
  return Result.ok(candidates);
};

/**
 * True when a thrown read error is the result of an aborted `AbortSignal`. Node surfaces this as
 * an `Error` with `name === 'AbortError'` and `code === 'ABORT_ERR'`; we also treat an already-
 * fired signal as decisive in case the runtime races the throw.
 */
const isAbortedRead = (cause: unknown, signal: AbortSignal | undefined): boolean => {
  if (signal?.aborted === true) return true;
  if (cause instanceof Error) {
    if (cause.name === 'AbortError') return true;
    if ((cause as { code?: unknown }).code === 'ABORT_ERR') return true;
  }
  return false;
};
