/** One-shot reader for a file under a sprint directory, shared by the read-only document overlays. */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';
import { fmtDuration } from '@src/application/ui/tui/theme/duration.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';

export type SprintDocument =
  | { readonly kind: 'ok'; readonly content: string; readonly modifiedAtMs: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'empty'; readonly modifiedAtMs: number }
  | { readonly kind: 'failed'; readonly message: string };

export const readSprintDocument = async (
  dataRoot: AbsolutePath,
  sprintId: SprintId,
  relativePath: string
): Promise<SprintDocument> => {
  try {
    // Tolerant id-prefix resolver so both `<id>--<slug>/` and the legacy bare `<id>/` are
    // found — a hand-built `sprints/<id>` would split-brain against a slug-renamed dir.
    const dir = await resolveSprintDir(dataRoot, sprintId);
    if (dir === undefined) return { kind: 'missing' };
    const absolute = join(dir, relativePath);
    const [stat, content] = await Promise.all([fs.stat(absolute), fs.readFile(absolute, 'utf8')]);
    const modifiedAtMs = stat.mtimeMs;
    if (content.trim().length === 0) return { kind: 'empty', modifiedAtMs };
    return { kind: 'ok', content, modifiedAtMs };
  } catch (cause) {
    const code = (cause as { code?: string } | undefined)?.code;
    if (code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'failed', message: messageOf(cause) };
  }
};

/** Strip a trailing newline so the last visible row isn't blank; keep interior empties. */
export const splitDocumentLines = (content: string): readonly string[] => content.replace(/\n+$/, '').split('\n');

export const formatAgo = (modifiedAtMs: number, now: number): string =>
  `${fmtDuration(Math.max(0, now - modifiedAtMs))} ago`;
