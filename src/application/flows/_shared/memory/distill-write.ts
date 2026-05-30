import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { DistillLearningsCtx } from '@src/application/flows/_shared/memory/distill-ctx.ts';

export interface DistillWriteLeafDeps {
  readonly writeFile: WriteFile;
  readonly logger: Logger;
  readonly clock: () => IsoTimestamp;
}

interface DistillWriteInput {
  readonly accepted: boolean;
  readonly proposedContent: string | undefined;
  readonly targetPath: AbsolutePath | undefined;
}

/**
 * Distill-OWNED terminal write leaf — scoped to one {@link AssistantTool} per instance. Mirrors
 * the readiness write leaf's contract WITHOUT touching it (RULING 3):
 *
 *  - `accepted !== true` → no-op. The trace records `completed`; no filesystem write happens.
 *  - target file already exists → a backup lands at `<targetPath>.bak.<filesystem-safe-ISO>`
 *    BEFORE the new content, so the operator can roll back. Colons in the stamp become hyphens
 *    so the filename is portable across every filesystem the harness runs on.
 *  - the new content is written via the {@link WriteFile} port — atomic in production
 *    (write-temp + rename), in-memory in tests.
 *
 * One real file is written per distinct provider (§10) — never a symlink or pointer scheme.
 *
 * The leaf returns `true` when it actually wrote (accepted + content present), `false` otherwise.
 * The sub-chain reads that back to know whether ANY provider's write landed — the terminal stamp
 * leaf only promotes the candidates once at least one native file received them.
 */
const distillWriteUseCase = async (
  deps: DistillWriteLeafDeps,
  tool: AssistantTool,
  input: DistillWriteInput
): Promise<Result<boolean, DomainError>> => {
  const log = deps.logger.named(`memory.distill-write-${tool}`);
  if (!input.accepted || input.proposedContent === undefined || input.targetPath === undefined) {
    log.info('skipping distill write — proposal not accepted');
    return Result.ok(false);
  }

  const targetPath = input.targetPath;
  if (await fileExists(String(targetPath))) {
    const existing = await safeReadText(String(targetPath));
    if (existing !== undefined) {
      const parsedBackup = AbsolutePath.parse(makeBackupPath(targetPath, deps.clock()));
      if (!parsedBackup.ok) return Result.error(parsedBackup.error);
      const backup = await deps.writeFile(parsedBackup.value, existing);
      if (!backup.ok) return Result.error(backup.error);
      log.info(`backup written at ${String(parsedBackup.value)}`, { backupPath: String(parsedBackup.value) });
    }
  }

  const written = await deps.writeFile(targetPath, input.proposedContent);
  if (!written.ok) return Result.error(written.error);

  log.info(`wrote distilled learnings to ${String(targetPath)}`, {
    targetPath: String(targetPath),
    bytes: input.proposedContent.length,
  });
  return Result.ok(true);
};

const makeBackupPath = (targetPath: AbsolutePath, now: IsoTimestamp): string =>
  `${String(targetPath)}.bak.${String(now).replace(/:/g, '-')}`;

const fileExists = async (path: string): Promise<boolean> => {
  try {
    return (await fs.stat(path)).isFile();
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

/**
 * Build the distill-owned write leaf for one tool. On a write, accumulates the loaded candidate
 * ids onto `ctx.acceptedIds` (deduped) so the terminal stamp leaf promotes them. Candidates are
 * project-scoped — the same curated set folds into every provider's native file — so a successful
 * write for ANY provider marks the whole set ready for promotion.
 *
 * @public
 */
export const distillWriteLeaf = (deps: DistillWriteLeafDeps, tool: AssistantTool): Element<DistillLearningsCtx> =>
  leaf<DistillLearningsCtx, DistillWriteInput, boolean>(`distill-write-${tool}`, {
    useCase: {
      execute: async (input) => distillWriteUseCase(deps, tool, input),
    },
    input: (ctx) => {
      const entry = ctx.entries[tool];
      if (entry?.accepted === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-distill-write',
          attemptedAction: 'distill-write',
          message: `distill-write-${tool}: ctx.entries[${tool}].accepted is undefined — distill-confirm must run first`,
        });
      }
      return { accepted: entry.accepted, proposedContent: entry.proposedContent, targetPath: entry.targetPath };
    },
    output: (ctx, wrote) => {
      if (!wrote) return ctx;
      const candidateIds = (ctx.candidates ?? []).map((c) => c.id);
      const merged = new Set([...(ctx.acceptedIds ?? []), ...candidateIds]);
      return { ...ctx, acceptedIds: [...merged] };
    },
  });
