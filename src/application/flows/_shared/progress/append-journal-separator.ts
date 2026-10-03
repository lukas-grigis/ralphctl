import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { renderJournalSeparator } from '@src/business/sprint/render-journal-entry.ts';
import { withSprintStateStatus } from '@src/business/sprint/render-sprint-state-header.ts';
import type { SprintStatus } from '@src/domain/entity/sprint.ts';

/**
 * Append one status-transition separator line to `<sprintDir>/progress.md` (audit-[07]).
 *
 * Wired immediately after a sprint status transition leaf so the journal records `activated`,
 * `transitioned to review`, and `closed` events in chronological order between task-attempt
 * sections. Generic over the surrounding ctx because the close-sprint flow has a different
 * ctx type than the implement flow.
 *
 * With `writeFile` wired, the header band's `- State:` line is rewritten to the new status in the
 * same atomic write; without it (or when the file cannot be read) the separator is appended.
 *
 * Best-effort: a write failure is logged and the chain proceeds.
 *
 * @public
 */
export interface AppendJournalSeparatorDeps {
  readonly appendFile: AppendFile;
  readonly writeFile?: WriteFile;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export interface AppendJournalSeparatorOpts {
  readonly progressFile: AbsolutePath;
  readonly status: 'activated' | 'review' | 'closed';
  readonly name: string;
}

const STATE_AFTER: Readonly<Record<AppendJournalSeparatorOpts['status'], SprintStatus>> = {
  activated: 'active',
  review: 'review',
  closed: 'done',
};

const readJournal = async (path: AbsolutePath): Promise<string | undefined> => {
  try {
    return await fs.readFile(String(path), 'utf8');
  } catch {
    return undefined;
  }
};

const writeSeparator = async (
  deps: AppendJournalSeparatorDeps,
  input: AppendJournalSeparatorOpts,
  text: string
): Promise<Result<void, StorageError>> => {
  const existing = deps.writeFile !== undefined ? await readJournal(input.progressFile) : undefined;
  if (deps.writeFile === undefined || existing === undefined) return deps.appendFile(input.progressFile, text);
  return deps.writeFile(input.progressFile, withSprintStateStatus(existing, STATE_AFTER[input.status]) + text);
};

export const appendJournalSeparatorLeaf = <TCtx>(
  deps: AppendJournalSeparatorDeps,
  opts: AppendJournalSeparatorOpts
): Element<TCtx> =>
  leaf<TCtx, AppendJournalSeparatorOpts, void>(opts.name, {
    useCase: {
      execute: async (input) => {
        const text = renderJournalSeparator({ status: input.status, at: deps.clock() });
        const result = await writeSeparator(deps, input, text);
        if (!result.ok) {
          deps.logger
            .named('progress-journal.separator')
            .warn(`${opts.name} append failed`, { path: String(input.progressFile), error: result.error.message });
        }
        return Result.ok(undefined);
      },
    },
    input: () => opts,
    output: (ctx) => ctx,
  });
