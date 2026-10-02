/**
 * Read-on-open loader for an attempt's `evaluation.md`, mirroring `useProgressFile`'s contract:
 * load on mount / dep-change behind a `cancelled` flag, `ENOENT` → a friendly missing state,
 * anything else → a diag line. No tailing — closing and re-pressing `v` gets a fresh snapshot.
 *
 * Two arms exist here that the progress overlay has no need for, and both are HARD DEGRADE paths
 * rather than errors:
 *
 *   - `unrecorded` — the attempt has a verdict but no artifact path. Legacy `tasks.json` rows
 *     predate the artifact, and a hand-edited or hostile row can carry an absolute path or one
 *     climbing out of the workspace; `evaluationArtifactSprintPath` refuses those, and refusal
 *     lands here. Resolved WITHOUT touching disk.
 *   - `missing` — the path is fine but the file is gone (a pruned workspace, a `data/` restore).
 *     Carries the relative path so the operator can see what was looked for.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { useEffect, useState } from 'react';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';
import { evaluationArtifactSprintPath } from '@src/business/task/evaluation-artifact.ts';
import { parseEvaluationMarkdown, type ParsedEvaluation } from '@src/business/task/parse-evaluation-md.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { EvaluationTarget } from '@src/application/ui/tui/runtime/evaluation-target.ts';

export type EvaluationFileState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unrecorded' }
  | { readonly kind: 'missing'; readonly relativePath: string }
  | { readonly kind: 'empty'; readonly relativePath: string; readonly modifiedAtMs: number }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ok';
      readonly relativePath: string;
      readonly parsed: ParsedEvaluation;
      /** Raw file rows, used as the fallback body when the parse yields nothing recognisable. */
      readonly rawLines: readonly string[];
      readonly modifiedAtMs: number;
    };

export const useEvaluationFile = (
  target: EvaluationTarget | undefined,
  dataRoot: AbsolutePath
): EvaluationFileState => {
  const [state, setState] = useState<EvaluationFileState>({ kind: 'loading' });
  // Destructured so the effect's dep list is primitives, not the target object identity — a
  // re-render of the opening view must not re-read the file.
  const sprintId = target?.sprintId;
  const taskId = target?.taskId;
  const file = target?.file;

  useEffect(() => {
    let cancelled = false;
    if (sprintId === undefined || taskId === undefined || file === undefined) {
      setState({ kind: 'unrecorded' });
      return undefined;
    }
    const relativePath = evaluationArtifactSprintPath(taskId, file);
    if (relativePath === undefined) {
      setState({ kind: 'unrecorded' });
      return undefined;
    }
    const load = async (): Promise<void> => {
      try {
        // Tolerant id-prefix resolver so both `<id>--<slug>/` and the legacy bare `<id>/` are
        // found — a hand-built `sprints/<id>` would split-brain against a slug-renamed dir.
        const dir = await resolveSprintDir(dataRoot, sprintId);
        if (cancelled) return;
        if (dir === undefined) {
          setState({ kind: 'missing', relativePath });
          return;
        }
        const absolute = join(dir, relativePath);
        const [stat, content] = await Promise.all([fs.stat(absolute), fs.readFile(absolute, 'utf8')]);
        if (cancelled) return;
        const modifiedAtMs = stat.mtimeMs;
        if (content.trim().length === 0) {
          setState({ kind: 'empty', relativePath, modifiedAtMs });
          return;
        }
        setState({
          kind: 'ok',
          relativePath,
          parsed: parseEvaluationMarkdown(content),
          // Strip a trailing newline so the last visible row isn't blank; keep interior empties.
          rawLines: content.replace(/\n+$/, '').split('\n'),
          modifiedAtMs,
        });
      } catch (cause) {
        if (cancelled) return;
        const code = (cause as { code?: string } | undefined)?.code;
        if (code === 'ENOENT') {
          setState({ kind: 'missing', relativePath });
          return;
        }
        setState({ kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [sprintId, taskId, file, dataRoot]);

  return state;
};
