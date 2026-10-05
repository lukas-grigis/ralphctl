import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';
import { writeWithBackup } from '@src/application/flows/_shared/write-with-backup.ts';

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
 * Terminal write leaf — scoped to one {@link AssistantTool} per instance.
 *
 * - When the matching entry's `accepted !== true` → no-op. The trace records `completed` with
 *   the entry's proposal untouched. Tests assert the absence of any filesystem write here.
 * - When the target file already exists → write a backup at
 *   `<targetPath>.bak.<timestamp>` BEFORE the new content lands. `<timestamp>` is the
 *   filesystem-safe ISO-8601 stamp `YYYY-MM-DDTHH-mm-ss-SSSZ` (colons replaced with hyphens
 *   so it lands cleanly on every filesystem). An existing file that can't be read refuses the write.
 * - The new content is written via the {@link WriteFile} port — atomic in production
 *   (`writeTextAtomic`), in-memory in tests.
 *
 * Backup decision: lean toward yes (per P10 spec's open question). The user already accepted
 * the new body; the backup is insurance against a regret in the next 30 seconds. Emitting a
 * stamped backup keeps each rollback point inspectable.
 */
const writeReadinessUseCase = async (
  deps: WriteReadinessLeafDeps,
  tool: AssistantTool,
  input: WriteReadinessInput
): Promise<Result<void, DomainError>> => {
  const log = deps.logger.named(`readiness.write-${tool}`);
  if (!input.accepted || input.proposal === undefined) {
    log.info('skipping write — proposal not accepted');
    return Result.ok(undefined);
  }

  const targetPath = input.proposal.targetPath;
  const written = await writeWithBackup(
    { writeFile: deps.writeFile, clock: deps.clock, logger: log },
    targetPath,
    input.proposal.proposedContent,
    `readiness.write-${tool}`
  );
  if (!written.ok) return Result.error(written.error);

  log.info(`wrote ${String(targetPath)}`, {
    targetPath: String(targetPath),
    bytes: input.proposal.proposedContent.length,
  });

  return Result.ok(undefined);
};

export const writeReadinessLeaf = (deps: WriteReadinessLeafDeps, tool: AssistantTool): Element<ReadinessCtx> =>
  leaf<ReadinessCtx, WriteReadinessInput, void>(`write-${tool}`, {
    useCase: {
      execute: async (input) => writeReadinessUseCase(deps, tool, input),
    },
    input: (ctx) => {
      const entry = ctx.entries[tool];
      // `accepted` always lands by the matching `confirmReadinessLeaf`; defensively treat
      // undefined as decline.
      if (entry?.accepted === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-write',
          attemptedAction: 'write',
          message: `write: ctx.entries[${tool}].accepted is undefined — confirm must run first`,
        });
      }
      return { accepted: entry.accepted, proposal: entry.proposal };
    },
    output: (ctx) => ctx,
    label: 'Write setup',
  });
