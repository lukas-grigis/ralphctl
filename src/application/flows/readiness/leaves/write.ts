import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';

export interface WriteReadinessLeafDeps {
  readonly writeFile: WriteFile;
  readonly logger: Logger;
  readonly clock: () => IsoTimestamp;
}

interface WriteReadinessInput {
  readonly accepted: boolean;
  readonly proposal: { readonly proposedContent: string; readonly targetPath: AbsolutePath } | undefined;
}

/**
 * Terminal write leaf.
 *
 * - When `ctx.accepted !== true` → no-op. The trace records `completed` with the proposal in
 *   ctx untouched. Tests assert the absence of any filesystem write here.
 * - When the target file already exists → write a backup at
 *   `<targetPath>.bak.<timestamp>` BEFORE the new content lands. `<timestamp>` is the
 *   filesystem-safe ISO-8601 stamp `YYYY-MM-DDTHH-mm-ss-SSSZ` (colons replaced with hyphens
 *   so it lands cleanly on every filesystem).
 * - The new content is written via the {@link WriteFile} port — atomic in production
 *   (`writeTextAtomic`), in-memory in tests.
 *
 * Backup decision: lean toward yes (per P10 spec's open question). The user already accepted
 * the new body; the backup is insurance against a regret in the next 30 seconds. Emitting a
 * stamped backup keeps each rollback point inspectable.
 */
const writeReadinessUseCase = async (
  deps: WriteReadinessLeafDeps,
  input: WriteReadinessInput
): Promise<Result<void, DomainError>> => {
  const log = deps.logger.named('readiness.write');
  if (!input.accepted || input.proposal === undefined) {
    log.info('skipping write — proposal not accepted');
    return Result.ok(undefined);
  }

  const targetPath = input.proposal.targetPath;
  const exists = await fileExists(String(targetPath));

  if (exists) {
    const backupPath = makeBackupPath(targetPath, deps.clock());
    const existing = await safeReadText(String(targetPath));
    if (existing !== undefined) {
      const parsedBackup = AbsolutePath.parse(backupPath);
      if (!parsedBackup.ok) return Result.error(parsedBackup.error);
      const backup = await deps.writeFile(parsedBackup.value, existing);
      if (!backup.ok) return Result.error(backup.error);
      log.info(`backup written at ${backupPath}`, { backupPath });
    }
  }

  const written = await deps.writeFile(targetPath, input.proposal.proposedContent);
  if (!written.ok) return Result.error(written.error);

  log.info(`wrote ${String(targetPath)}`, {
    targetPath: String(targetPath),
    bytes: input.proposal.proposedContent.length,
  });

  return Result.ok(undefined);
};

/**
 * Compose the backup path. Format: `<original>.bak.<filesystem-safe-ISO>`. `IsoTimestamp` is a
 * standard ISO-8601 string with colons; we swap colons for hyphens so the filename is portable
 * across every filesystem the harness runs on.
 */
const makeBackupPath = (targetPath: AbsolutePath, now: IsoTimestamp): string => {
  const stamp = String(now).replace(/:/g, '-');
  return `${String(targetPath)}.bak.${stamp}`;
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(path);
    return stat.isFile();
  } catch {
    return false;
  }
};

const safeReadText = async (path: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
};

export const writeReadinessLeaf = (deps: WriteReadinessLeafDeps): Element<ReadinessCtx> =>
  leaf<ReadinessCtx, WriteReadinessInput, void>('write', {
    useCase: {
      execute: async (input) => writeReadinessUseCase(deps, input),
    },
    input: (ctx) => {
      // `accepted` always lands by `confirmReadinessLeaf`; defensively treat undefined as decline.
      if (ctx.accepted === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-write',
          attemptedAction: 'write',
          message: 'write: ctx.accepted is undefined — confirm must run first',
        });
      }
      return { accepted: ctx.accepted, proposal: ctx.proposal };
    },
    output: (ctx) => ctx,
  });
