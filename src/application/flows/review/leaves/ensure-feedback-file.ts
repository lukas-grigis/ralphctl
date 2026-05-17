import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { renderEmptyRound } from '@src/business/feedback/md-parser.ts';
import type { ReviewCtx } from '@src/application/flows/review/ctx.ts';

/**
 * Materialise `<sprintDir>/feedback.md` if missing. Initial layout:
 *
 *     # Feedback
 *
 *     <!-- Each round below is separated by a `---` line. -->
 *
 *     ## Round 1
 *
 *     <!-- write your feedback below this line, or leave empty to end review -->
 *
 *     ---
 *
 * The user opens the file in their editor (`review-loop` does this on round 1) and writes
 * their first instructions under the marker comment.
 *
 * Idempotent: an existing file is not overwritten. Threads the path forward on
 * `ctx.feedbackFile` for downstream leaves.
 */

const TEMPLATE = `# Feedback

<!-- Each round below is separated by a \`---\` line. -->

${renderEmptyRound(1)}---
`;

export const ensureFeedbackFileLeaf = (feedbackFile: AbsolutePath): Element<ReviewCtx> =>
  leaf<ReviewCtx, AbsolutePath, void>('ensure-feedback-file', {
    useCase: {
      execute: async (path) => {
        try {
          await fs.access(String(path));
          return Result.ok(undefined) as Result<void, StorageError>;
        } catch {
          // File missing — create it with the template.
        }
        try {
          await fs.writeFile(String(path), TEMPLATE, { flag: 'wx' });
          return Result.ok(undefined) as Result<void, StorageError>;
        } catch (cause) {
          if (typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'EEXIST') {
            return Result.ok(undefined) as Result<void, StorageError>;
          }
          return Result.error(
            new StorageError({
              subCode: 'io',
              message: `failed to create feedback file: ${String(path)}`,
              path: String(path),
              cause,
            })
          );
        }
      },
    },
    input: () => feedbackFile,
    output: (ctx) => ({ ...ctx, feedbackFile }),
  });
