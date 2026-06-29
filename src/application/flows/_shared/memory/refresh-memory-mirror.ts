import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import { resolveLearningsLedgerPath } from '@src/application/flows/_shared/memory/ledger-path.ts';
import { isAbortedRead } from '@src/application/flows/_shared/memory/abort-guard.ts';
import { readLedgerLines } from '@src/application/flows/_shared/memory/read-ledger.ts';
import { mirrorLearningsMd } from '@src/application/flows/_shared/memory/ledger-writer.ts';

const LEAF_NAME = 'refresh-memory-mirror';

export interface RefreshMemoryMirrorLeafDeps {
  readonly writeFile: WriteFile;
  readonly logger: Logger;
}

export interface RefreshMemoryMirrorLeafOpts {
  /** `<dataRoot>/memory` — the durable, project-scoped learnings root. */
  readonly memoryRoot: AbsolutePath;
  /** Owning project's id — selects the per-project ledger subdirectory (tolerant READ resolver). */
  readonly projectId: string;
}

/**
 * ALWAYS-ON capture leaf for the durable NARRATIVE tier of project memory. At sprint close it reads
 * the project's append-only ledger and regenerates the human-browsable `learnings.md` mirror — the
 * durable narrative of everything the project's sprints have learned AND decided.
 *
 * This is the lazy-render checkpoint that pairs with the audit's hot-path change: the per-attempt
 * append no longer regenerates the mirror (that O(n) read+reparse+rewrite left the gen-eval critical
 * path), so the mirror is rendered at the natural moments a human is about to read it — distill, and
 * here at close. It runs INDEPENDENT of the heavyweight, human-gated distill (which curates the
 * authoritative provider-native context file): a user who closes WITHOUT distilling still gets a
 * fresh narrative mirror.
 *
 * Best-effort and never blocking:
 *  - absent / empty ledger → no-op (`Result.ok`); a project that recorded nothing has no mirror.
 *  - any non-abort read/render failure → logged at warn, `Result.ok` — the ledger stays the source
 *    of truth and a stale mirror heals on the next render.
 *  - a CANCELLED read re-propagates `AbortError` (the one error chains forward transparently) so a
 *    mid-close Ctrl+C is never swallowed into a silent no-op.
 *
 * Malformed individual lines are skipped (the mirror is a derived view; one bad row must not orphan
 * the rest). Runs BEFORE the gated distill step so the mirror reflects the pre-distill ledger; the
 * distill's own stamp leaf re-renders it afterwards if any promotion landed.
 *
 * @public
 */
export const refreshMemoryMirrorLeaf = <TCtx>(
  deps: RefreshMemoryMirrorLeafDeps,
  opts: RefreshMemoryMirrorLeafOpts
): Element<TCtx> =>
  leaf<TCtx, Record<string, never>, void>(LEAF_NAME, {
    useCase: {
      execute: async (_input, signal) => refresh(deps, opts, signal),
    },
    input: () => ({}),
    output: (ctx) => ctx,
  });

const refresh = async (
  deps: RefreshMemoryMirrorLeafDeps,
  opts: RefreshMemoryMirrorLeafOpts,
  signal: AbortSignal | undefined
): Promise<Result<void, DomainError>> => {
  const log = deps.logger.named('memory.refresh-mirror');

  const resolved = await resolveLearningsLedgerPath(opts.memoryRoot, opts.projectId);
  if (!resolved.ok) {
    log.warn('could not resolve ledger path — skipping mirror refresh', { error: resolved.error.message });
    return Result.ok(undefined);
  }
  const path = resolved.value;

  let records: LearningRecord[];
  try {
    records = [];
    for (const { record, parseError } of await readLedgerLines(path, log, signal)) {
      if (parseError !== undefined) {
        log.warn('skipping malformed learnings.ndjson line while refreshing the mirror', {
          error: parseError.message,
        });
        continue;
      }
      if (record !== undefined) records.push(record);
    }
  } catch (cause) {
    // A cancelled read must re-propagate `AbortError`, never collapse into "no mirror".
    if (isAbortedRead(cause, signal)) return Result.error(new AbortError({ elementName: LEAF_NAME }));
    log.warn('could not read ledger — skipping mirror refresh', { path: String(path), error: String(cause) });
    return Result.ok(undefined);
  }

  if (records.length === 0) {
    log.info('no ledger records — skipping mirror refresh', { path: String(path) });
    return Result.ok(undefined);
  }

  await mirrorLearningsMd(path, records, deps.writeFile, log);
  log.info(`refreshed learnings.md mirror from ${String(records.length)} record(s)`, {
    path: String(path),
    count: records.length,
  });
  return Result.ok(undefined);
};
