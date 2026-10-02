/**
 * Shared run-engine for the per-sprint markdown export views (context.md / requirements.md).
 *
 * Both export views are one-shot: fire on mount, render the result, allow re-run with `r`. This
 * hook owns everything they share — the RunState machine, the monotonic run token that voids a
 * stale or post-unmount run, sprint-dir resolution, output-path building, the `r` rebind, and the
 * `rerun` view hint. Each view supplies only its `filename` and a `run` callback that executes its
 * flow against the resolved output path; the differing titles/labels live in the presentation
 * component. See {@link MarkdownExportView}.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { join } from 'node:path';
import { useInput } from 'ink';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

/** @public */
export type MarkdownExportRunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly path: string; readonly bytes: number }
  | { readonly kind: 'error'; readonly message: string };

/** Normalized outcome the view's flow call hands back to the hook. */
export type MarkdownExportOutcome =
  | { readonly ok: true; readonly path: string; readonly bytes: number }
  | { readonly ok: false; readonly message: string };

export interface UseMarkdownExportConfig {
  /** Output filename written under the resolved sprint dir, e.g. `context.md`. */
  readonly filename: string;
  /** Execute the export flow for the resolved output path; normalize success/failure to an outcome. */
  readonly run: (ctx: {
    readonly outputPath: AbsolutePath;
    readonly sprintId: SprintId;
  }) => Promise<MarkdownExportOutcome>;
  /** Caller-owned deps that re-establish the run (selection ids, the deps handle, …). */
  readonly deps: readonly unknown[];
}

export const useMarkdownExport = (config: UseMarkdownExportConfig): MarkdownExportRunState => {
  const storage = useStorage();
  const selection = useSelection();
  const ui = useUiState();
  const [run, setRun] = useState<MarkdownExportRunState>({ kind: 'idle' });

  // Monotonic run token: a later run (selection change, unmount, or `r` retry) bumps this so an
  // earlier in-flight run's post-await setRun calls become no-ops — no setState-after-unmount and
  // no stale run clobbering a newer one.
  const runGenRef = useRef(0);
  // Capture view-supplied values in refs so a fresh arrow/string each render does not churn the
  // run callback; it re-creates only when the caller's own `deps` change (same anti-churn invariant
  // as use-coalesced-buffer).
  const runFnRef = useRef(config.run);
  runFnRef.current = config.run;
  const filenameRef = useRef(config.filename);
  filenameRef.current = config.filename;

  useViewHints([{ keys: 'r', label: 'rerun' }]);

  const runExport = useCallback(async (): Promise<void> => {
    const gen = (runGenRef.current += 1);
    const live = (): boolean => runGenRef.current === gen;
    if (selection.sprintId === undefined) {
      setRun({ kind: 'error', message: 'No sprint selected.' });
      return;
    }
    // Resolve the sprint dir via the tolerant id-prefix resolver (both `<id>--<slug>/` and the
    // legacy bare `<id>/`); the view only holds the sprint id, not the entity.
    const sprintDir = await resolveSprintDir(storage.dataRoot, selection.sprintId);
    if (!live()) return;
    if (sprintDir === undefined) {
      setRun({ kind: 'error', message: 'Sprint directory not found on disk.' });
      return;
    }
    const outputPath = AbsolutePath.parse(join(sprintDir, filenameRef.current));
    if (!outputPath.ok) {
      setRun({ kind: 'error', message: outputPath.error.message });
      return;
    }
    setRun({ kind: 'running' });
    const outcome = await runFnRef.current({ outputPath: outputPath.value, sprintId: selection.sprintId });
    if (!live()) return;
    setRun(
      outcome.ok
        ? { kind: 'done', path: outcome.path, bytes: outcome.bytes }
        : { kind: 'error', message: outcome.message }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are caller-owned by contract.
  }, [storage, selection.sprintId, ...config.deps]);

  useEffect(() => {
    void runExport();
    // Teardown (selection change → new runExport, or unmount) invalidates any in-flight run.
    return () => {
      runGenRef.current += 1;
    };
  }, [runExport]);

  useInput((input) => {
    if (ui.modalOpen) return;
    if (input === 'r') void runExport();
  });

  return run;
};
