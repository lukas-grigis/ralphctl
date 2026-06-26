/**
 * Export-harness-context view — runs the {@link exportContext} use case for the currently
 * selected project + sprint and reports where the markdown was written. The use case is
 * one-shot (load × 3 → render → write) so the view follows the same shape as DoctorView:
 * fire on mount, render the result, allow re-run with `r`.
 *
 * Output convention mirrors the other per-sprint artifacts (progress.md, plan/, refinement/):
 *   `<dataRoot>/sprints/<sprintId>/context.md`
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { join } from 'node:path';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { createExportContextFlow } from '@src/application/flows/export-context/flow.ts';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';

type RunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly path: string; readonly bytes: number }
  | { readonly kind: 'error'; readonly message: string };

export const ExportContextView = (): React.JSX.Element => {
  const deps = useDeps();
  const storage = useStorage();
  const selection = useSelection();
  const ui = useUiState();
  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  // Monotonic run token: a later run (selection change, unmount, or `r` retry) bumps this so an
  // earlier in-flight run's post-await setRun calls become no-ops — no setState-after-unmount and
  // no stale run clobbering a newer one.
  const runGenRef = useRef(0);
  useViewHints([{ keys: 'r', label: 'rerun' }]);

  const runExport = useCallback(async (): Promise<void> => {
    const gen = (runGenRef.current += 1);
    const live = (): boolean => runGenRef.current === gen;
    if (selection.projectId === undefined || selection.sprintId === undefined) {
      setRun({ kind: 'error', message: 'No project or sprint selected.' });
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
    const outputPath = AbsolutePath.parse(join(sprintDir, 'context.md'));
    if (!outputPath.ok) {
      setRun({ kind: 'error', message: outputPath.error.message });
      return;
    }
    setRun({ kind: 'running' });
    const flow = createExportContextFlow({
      sprintRepo: deps.sprintRepo,
      projectRepo: deps.projectRepo,
      taskRepo: deps.taskRepo,
      writeFile: deps.writeFile,
    });
    const result = await flow.execute({
      input: { sprintId: selection.sprintId, projectId: selection.projectId, outputPath: outputPath.value },
    });
    if (!live()) return;
    if (!result.ok) {
      setRun({ kind: 'error', message: result.error.error.message });
      return;
    }
    const out = result.value.ctx.output!;
    setRun({ kind: 'done', path: String(out.outputPath), bytes: out.byteCount });
  }, [deps, storage, selection.projectId, selection.sprintId]);

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

  return (
    <ViewShell title="Export harness context" subtitle="sprint + tickets + tasks + project → markdown">
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : (
        <Box flexDirection="column" paddingX={spacing.indent} marginTop={spacing.section}>
          {run.kind === 'idle' || run.kind === 'running' ? (
            <Spinner label="Writing context markdown…" />
          ) : run.kind === 'done' ? (
            <Card title="Done" tone="rule">
              <Text>
                <Text color={inkColors.primary} bold>
                  {glyphs.check}{' '}
                </Text>
                Wrote <Text bold>{run.path}</Text>
              </Text>
              <Text dimColor>
                {String(run.bytes)} bytes {glyphs.bullet} press r to re-render
              </Text>
            </Card>
          ) : (
            <Card title="Failed" tone="rule">
              <Text color={inkColors.error}>
                {glyphs.bullet} {run.message}
              </Text>
              <Text dimColor>press r to retry</Text>
            </Card>
          )}
        </Box>
      )}
    </ViewShell>
  );
};
