import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { sprintDir } from '@src/integration/persistence/storage.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { renderJournalSprintHeader } from '@src/business/sprint/render-journal-entry.ts';
import type { CreateSprintCtx } from '@src/application/flows/create-sprint/ctx.ts';

/**
 * Write the one-time sprint header into `<sprintDir>/progress.md` immediately after the
 * sprint is saved (audit-[07]). The header carries invariant metadata only — sprint name,
 * id, created-at. No ticket list (tickets are mutable; `sprint.json` is canonical).
 *
 * The append-only journal grows from here: subsequent task-attempt sections and status
 * transitions are appended chronologically by their respective leaves.
 *
 * Best-effort by contract: a write failure is logged and the chain proceeds. The header is a
 * forensic aid for operators / re-entering AI sessions; blocking sprint creation on a journal
 * hiccup would be worse than letting the operator notice and re-touch the file.
 */
export interface InitProgressJournalLeafDeps {
  readonly appendFile: AppendFile;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export interface InitProgressJournalLeafOpts {
  /** `<dataRoot>` — the leaf derives `<dataRoot>/sprints/<id>/progress.md` from the saved sprint. */
  readonly dataRoot: AbsolutePath;
}

interface LeafInput {
  readonly sprintName: string;
  readonly sprintId: string;
  readonly progressFile: AbsolutePath;
}

export const initProgressJournalLeaf = (
  deps: InitProgressJournalLeafDeps,
  opts: InitProgressJournalLeafOpts
): Element<CreateSprintCtx> =>
  leaf<CreateSprintCtx, LeafInput, void>('init-progress-journal', {
    useCase: {
      execute: async (input) => {
        const text = renderJournalSprintHeader({
          sprintName: input.sprintName,
          sprintId: input.sprintId,
          createdAt: deps.clock(),
        });
        const result = await deps.appendFile(input.progressFile, text);
        if (!result.ok) {
          deps.logger.named('create-sprint.init-progress-journal').warn('progress.md header append failed', {
            path: String(input.progressFile),
            error: result.error.message,
          });
        }
        return Result.ok(undefined) as Result<void, StorageError | InvalidStateError>;
      },
    },
    input: (ctx) => {
      if (ctx.sprint === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-init-progress-journal',
          attemptedAction: 'init-progress-journal',
          message: 'init-progress-journal: ctx.sprint is undefined — create-sprint must run first',
        });
      }
      // Direct-build the canonical `<id>--<slug>/` sprint dir — `ctx.sprint` is the freshly-saved
      // entity here, so its slug is in hand and no async resolver scan is needed.
      const progressFile = AbsolutePath.parse(
        join(sprintDir(opts.dataRoot, ctx.sprint.id, ctx.sprint.slug), 'progress.md')
      );
      if (!progressFile.ok) throw progressFile.error;
      return {
        sprintName: ctx.sprint.name,
        sprintId: String(ctx.sprint.id),
        progressFile: progressFile.value,
      };
    },
    output: (ctx) => ctx,
  });
