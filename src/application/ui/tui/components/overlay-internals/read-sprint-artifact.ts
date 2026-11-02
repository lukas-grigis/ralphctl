import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

export type SprintArtifact =
  | { readonly kind: 'missing' }
  | { readonly kind: 'empty'; readonly modifiedAtMs: number }
  | { readonly kind: 'ok'; readonly content: string; readonly lines: readonly string[]; readonly modifiedAtMs: number }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Read a file under a sprint's directory for a read-only overlay. Never throws: a missing sprint dir
 * or `ENOENT` is `missing`, any other error `failed`. The dir goes through the tolerant id-prefix
 * resolver so both `<id>--<slug>/` and the legacy bare `<id>/` are found — a hand-built path would
 * split-brain against a slug-renamed dir. `lines` drops the trailing newline so the last row isn't blank.
 */
export const readSprintArtifact = async (
  dataRoot: AbsolutePath,
  sprintId: SprintId,
  relativePath: string
): Promise<SprintArtifact> => {
  try {
    const dir = await resolveSprintDir(dataRoot, sprintId);
    if (dir === undefined) return { kind: 'missing' };
    const absolute = join(dir, relativePath);
    const [stat, content] = await Promise.all([fs.stat(absolute), fs.readFile(absolute, 'utf8')]);
    if (content.trim().length === 0) return { kind: 'empty', modifiedAtMs: stat.mtimeMs };
    return { kind: 'ok', content, lines: content.replace(/\n+$/, '').split('\n'), modifiedAtMs: stat.mtimeMs };
  } catch (cause) {
    if ((cause as { code?: string } | undefined)?.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) };
  }
};
