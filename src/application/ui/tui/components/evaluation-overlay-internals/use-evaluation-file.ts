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

import { useEffect, useState } from 'react';
import { readSprintArtifact } from '@src/application/ui/tui/components/overlay-internals/read-sprint-artifact.ts';
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
    if (sprintId === undefined || taskId === undefined || file === undefined) {
      setState({ kind: 'unrecorded' });
      return undefined;
    }
    const relativePath = evaluationArtifactSprintPath(taskId, file);
    if (relativePath === undefined) {
      setState({ kind: 'unrecorded' });
      return undefined;
    }
    let cancelled = false;
    void readSprintArtifact(dataRoot, sprintId, relativePath).then((artifact) => {
      if (cancelled) return;
      switch (artifact.kind) {
        case 'ok':
          setState({
            kind: 'ok',
            relativePath,
            parsed: parseEvaluationMarkdown(artifact.content),
            rawLines: artifact.lines,
            modifiedAtMs: artifact.modifiedAtMs,
          });
          return;
        case 'failed':
          setState(artifact);
          return;
        default:
          setState({ ...artifact, relativePath });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sprintId, taskId, file, dataRoot]);

  return state;
};
