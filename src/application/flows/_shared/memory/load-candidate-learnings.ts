import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import { selectPendingCandidates } from '@src/application/flows/_shared/memory/load-learnings.ts';
import { readLedgerLines } from '@src/application/flows/_shared/memory/read-ledger.ts';
import { resolveLearningsLedgerPath } from '@src/application/flows/_shared/memory/ledger-path.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';

/**
 * READ-side, NON-leaf variant of {@link loadLearningsLeaf}'s candidate load. Resolves the project's
 * learnings ledger (tolerant of the slugged `<id>--<slug>/` and legacy bare `<id>/` dir via
 * {@link resolveLearningsLedgerPath}), de-dups by record `id` (keeping the FIRST occurrence — the
 * write side stamps a stable id so a re-emitted record collapses onto one row), and keeps the rows
 * still awaiting promotion (`promotedAt === null`) that have NOT been durably retired. That is the
 * SAME candidate set the implement generator reads — both `learning` and `decision` kinds survive
 * (the renderer partitions them downstream).
 *
 * Exists because the interactive plan / ideate flows compose their prompt inside a
 * `render-prompt-to-file` callback (see `renderPromptToFileLeaf`), NOT a chain leaf, so they cannot
 * reuse {@link loadLearningsLeaf} directly. This gives them the identical filter without duplicating
 * it per flow, and without splitting the ledger's read path.
 *
 * Any read failure — an absent ledger being the common, expected case — resolves to an EMPTY list:
 * a missing or unreadable ledger must never block interactive planning. (The leaf variant
 * additionally re-propagates a cancelled read as `AbortError`; this path runs inside a prompt-render
 * callback that receives no `AbortSignal`, so there is nothing to honour here.)
 *
 * @public
 */
export const loadCandidateLearnings = async (
  memoryRoot: AbsolutePath,
  projectId: string,
  logger: Logger
): Promise<readonly LearningRecord[]> => {
  const resolved = await resolveLearningsLedgerPath(memoryRoot, projectId);
  if (!resolved.ok) return [];
  const log = logger.named('memory.load-candidate-learnings');

  try {
    const lines = await readLedgerLines(resolved.value, log);
    return selectPendingCandidates(lines);
  } catch (cause) {
    // A missing ledger is the common case (the project simply hasn't produced a learning); it —
    // and any other read failure — must never block interactive planning.
    log.info('no learnings ledger — injecting nothing', {
      path: String(resolved.value),
      error: messageOf(cause),
    });
    return [];
  }
};
