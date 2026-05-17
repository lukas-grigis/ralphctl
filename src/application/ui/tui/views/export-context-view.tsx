/**
 * Export-harness-context view — runs the {@link exportContext} use case for the currently
 * selected project + sprint and reports where the markdown was written. The use case is
 * one-shot (load × 3 → render → write) so the view follows the same shape as DoctorView:
 * fire on mount, render the result, allow re-run with `r`.
 *
 * Output convention mirrors the other per-sprint artifacts (progress.md, plan/, refinement/):
 *   `<dataRoot>/sprints/<sprintId>/context.md`
 */

import React, { useCallback, useEffect, useState } from 'react';
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
  useViewHints([{ keys: 'r', label: 'rerun' }]);

  const runExport = useCallback(async (): Promise<void> => {
    if (selection.projectId === undefined || selection.sprintId === undefined) {
      setRun({ kind: 'error', message: 'No project or sprint selected.' });
      return;
    }
    const outputPath = AbsolutePath.parse(
      join(String(storage.dataRoot), 'sprints', String(selection.sprintId), 'context.md')
    );
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
    if (!result.ok) {
      setRun({ kind: 'error', message: result.error.error.message });
      return;
    }
    const out = result.value.ctx.output!;
    setRun({ kind: 'done', path: String(out.outputPath), bytes: out.byteCount });
  }, [deps, storage, selection.projectId, selection.sprintId]);

  useEffect(() => {
    void runExport();
  }, [runExport]);

  useInput((input) => {
    if (ui.helpOpen || ui.promptActive) return;
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
