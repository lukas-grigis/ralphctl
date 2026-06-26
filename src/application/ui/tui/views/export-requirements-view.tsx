/**
 * Export-requirements view — runs the {@link exportRequirements} use case for the selected
 * sprint and reports where the markdown was written. One-shot (load → render → write) so
 * the view mirrors ExportContextView: fire on mount, render the result, `r` to re-run.
 *
 * Output convention matches the other per-sprint artifacts (context.md, plan/, refinement/):
 *   `<dataRoot>/sprints/<sprintId>/requirements.md`
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
import { createExportRequirementsFlow } from '@src/application/flows/export-requirements/flow.ts';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';
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
  // Monotonic run token: a later run (selection change, unmount, or `r` retry) bumps this so an
  // earlier in-flight run's post-await setRun calls become no-ops — no setState-after-unmount and
  // no stale run clobbering a newer one.
  const runGenRef = useRef(0);
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
    const outputPath = AbsolutePath.parse(join(sprintDir, 'requirements.md'));
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
    if (!live()) return;
    if (!result.ok) {
      setRun({ kind: 'error', message: result.error.error.message });
      return;
    }
    const out = result.value.ctx.output!;
    setRun({ kind: 'done', path: String(out.outputPath), bytes: out.byteCount });
  }, [deps, storage, selection.sprintId]);

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
