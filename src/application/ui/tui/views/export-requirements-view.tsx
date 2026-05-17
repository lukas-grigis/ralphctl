/**
 * Export-requirements view — runs the {@link exportRequirements} use case for the selected
 * sprint and reports where the markdown was written. One-shot (load → render → write) so
 * the view mirrors ExportContextView: fire on mount, render the result, `r` to re-run.
 *
 * Output convention matches the other per-sprint artifacts (context.md, plan/, refinement/):
 *   `<dataRoot>/sprints/<sprintId>/requirements.md`
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
import { createExportRequirementsFlow } from '@src/application/flows/export-requirements/flow.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';

type RunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly path: string; readonly bytes: number }
  | { readonly kind: 'error'; readonly message: string };

export const ExportRequirementsView = (): React.JSX.Element => {
  const deps = useDeps();
  const storage = useStorage();
  const selection = useSelection();
  const ui = useUiState();
  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  useViewHints([{ keys: 'r', label: 'rerun' }]);

  const runExport = useCallback(async (): Promise<void> => {
    if (selection.sprintId === undefined) {
      setRun({ kind: 'error', message: 'No sprint selected.' });
      return;
    }
    const outputPath = AbsolutePath.parse(
      join(String(storage.dataRoot), 'sprints', String(selection.sprintId), 'requirements.md')
    );
    if (!outputPath.ok) {
      setRun({ kind: 'error', message: outputPath.error.message });
      return;
    }
    setRun({ kind: 'running' });
    const flow = createExportRequirementsFlow({
      sprintRepo: deps.sprintRepo,
      writeFile: deps.writeFile,
    });
    const result = await flow.execute({
      input: { sprintId: selection.sprintId, outputPath: outputPath.value },
    });
    if (!result.ok) {
      setRun({ kind: 'error', message: result.error.error.message });
      return;
    }
    const out = result.value.ctx.output!;
    setRun({ kind: 'done', path: String(out.outputPath), bytes: out.byteCount });
  }, [deps, storage, selection.sprintId]);

  useEffect(() => {
    void runExport();
  }, [runExport]);

  useInput((input) => {
    if (ui.helpOpen || ui.promptActive) return;
    if (input === 'r') void runExport();
  });

  return (
    <ViewShell title="Export requirements" subtitle="approved-ticket requirements → markdown">
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : (
        <Box flexDirection="column" paddingX={spacing.indent} marginTop={spacing.section}>
          {run.kind === 'idle' || run.kind === 'running' ? (
            <Spinner label="Writing requirements markdown…" />
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
