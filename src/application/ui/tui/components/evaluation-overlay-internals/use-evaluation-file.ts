/**
 * Read-on-open loader for an attempt's `evaluation.md`, mirroring `useProgressFile`'s contract: load on mount /
 * dep-change behind a `cancelled` flag.
 */

import { useEffect, useState } from 'react';
import { evaluationArtifactSprintPath } from '@src/business/task/evaluation-artifact.ts';
import { parseEvaluationMarkdown, type ParsedEvaluation } from '@src/business/task/parse-evaluation-md.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { EvaluationTarget } from '@src/application/ui/tui/runtime/evaluation-target.ts';
import {
  readSprintDocument,
  splitDocumentLines,
} from '@src/application/ui/tui/components/overlay-internals/read-sprint-document.ts';

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
      const doc = await readSprintDocument(dataRoot, sprintId, relativePath);
      if (cancelled) return;
      switch (doc.kind) {
        case 'ok':
          setState({
            kind: 'ok',
            relativePath,
            parsed: parseEvaluationMarkdown(doc.content),
            rawLines: splitDocumentLines(doc.content),
            modifiedAtMs: doc.modifiedAtMs,
          });
          return;
        case 'missing':
          setState({ kind: 'missing', relativePath });
          return;
        case 'empty':
          setState({ kind: 'empty', relativePath, modifiedAtMs: doc.modifiedAtMs });
          return;
        case 'failed':
          setState(doc);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [sprintId, taskId, file, dataRoot]);

  return state;
};
