/**
 * `learnings.md` backfill renderer for the data migration's apply step.
 *
 * The migration engine (`integration/persistence/data-migration/apply.ts`) backfills a
 * `learnings.md` mirror for every memory dir while it runs, but the pure markdown renderer
 * (`renderLearningsMd`) lives in the APPLICATION layer (`application/flows/_shared/memory/`),
 * which the integration layer cannot import (ESLint-fenced). So the engine declares a
 * {@link LearningsBackfillRenderer} port and the concrete adapter is injected HERE, where both
 * the raw-line parser and the renderer are reachable.
 *
 * Contract (per `LearningsBackfillRenderer`): take the raw NDJSON ledger body, return the
 * rendered markdown, or `undefined` when there is nothing renderable so the backfill skips the
 * write. We parse each line tolerantly — a malformed / blank line is dropped, never thrown —
 * because a backfill miss must never fail the migration (the runtime mirror heals it later).
 */

import { parseLearningLine, type LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import { renderLearningsMd } from '@src/application/flows/_shared/memory/render-learnings-md.ts';

/**
 * Build the backfill renderer the migration `ApplyCtx.renderLearnings` expects. Parses the NDJSON
 * body line-by-line (skipping blanks + malformed rows) then renders the markdown mirror. Returns
 * `undefined` when no record parses, so the engine skips writing an empty file.
 *
 * @public
 */
export const createLearningsBackfillRenderer =
  (): ((ndjsonBody: string) => string | undefined) =>
  (ndjsonBody): string | undefined => {
    const records: LearningRecord[] = [];
    for (const line of ndjsonBody.split('\n')) {
      const parsed = parseLearningLine(line);
      // Tolerant: a blank line yields `ok(undefined)`, a malformed line yields an error — both are
      // dropped. Backfill is best-effort; a bad row must not abort the migration.
      if (parsed.ok && parsed.value !== undefined) records.push(parsed.value);
    }
    if (records.length === 0) return undefined;
    return renderLearningsMd(records);
  };
