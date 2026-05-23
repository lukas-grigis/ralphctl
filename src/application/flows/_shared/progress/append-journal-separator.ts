import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { renderJournalSeparator } from '@src/business/sprint/render-journal-entry.ts';

/**
 * Append one status-transition separator line to `<sprintDir>/progress.md` (audit-[07]).
 *
 * Wired immediately after a sprint status transition leaf so the journal records `activated`,
 * `transitioned to review`, and `closed` events in chronological order between task-attempt
 * sections. Generic over the surrounding ctx because the close-sprint flow has a different
 * ctx type than the implement flow.
 *
 * Best-effort: a write failure is logged and the chain proceeds.
 *
 * @public
 */
export interface AppendJournalSeparatorDeps {
  readonly appendFile: AppendFile;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export interface AppendJournalSeparatorOpts {
  readonly progressFile: AbsolutePath;
  readonly status: 'activated' | 'review' | 'closed';
  readonly name: string;
}

export const appendJournalSeparatorLeaf = <TCtx>(
  deps: AppendJournalSeparatorDeps,
  opts: AppendJournalSeparatorOpts
): Element<TCtx> =>
  leaf<TCtx, AppendJournalSeparatorOpts, void>(opts.name, {
    useCase: {
      execute: async (input) => {
        const text = renderJournalSeparator({ status: input.status, at: deps.clock() });
        const result = await deps.appendFile(input.progressFile, text);
        if (!result.ok) {
          deps.logger
            .named('progress-journal.separator')
            .warn(`${opts.name} append failed`, { path: String(input.progressFile), error: result.error.message });
        }
        return Result.ok(undefined) as Result<void, StorageError | InvalidStateError>;
      },
    },
    input: () => opts,
    output: (ctx) => ctx,
  });
