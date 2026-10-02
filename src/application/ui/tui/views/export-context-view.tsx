/**
 * Export-harness-context view — runs the export-context flow for the selected project + sprint
 * and reports where the markdown was written. A thin wrapper over {@link MarkdownExportView},
 * which owns the shared one-shot run lifecycle (run token, sprint-dir resolution, `r` re-run).
 *
 * Output convention mirrors the other per-sprint artifacts (progress.md, plan/, refinement/):
 *   `<dataRoot>/sprints/<sprintId>/context.md`
 */

import React from 'react';
import { MarkdownExportView } from '@src/application/ui/tui/views/markdown-export-view.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { createExportContextFlow } from '@src/application/flows/export-context/flow.ts';

export const ExportContextView = (): React.JSX.Element => {
  const deps = useDeps();
  const selection = useSelection();

  return (
    <MarkdownExportView
      title="Export harness context"
      subtitle="sprint + tickets + tasks + project → markdown"
      spinnerLabel="Writing context markdown…"
      filename="context.md"
      deps={[deps, selection.projectId, selection.sprintId]}
      run={async ({ outputPath, sprintId }) => {
        // A sprint always belongs to a project, so projectId is defined whenever sprintId is; the
        // guard narrows the type (and degrades to an error rather than a crash if ever not).
        if (selection.projectId === undefined) return { ok: false, message: 'No project selected.' };
        const flow = createExportContextFlow({
          sprintRepo: deps.sprintRepo,
          projectRepo: deps.projectRepo,
          taskRepo: deps.taskRepo,
          writeFile: deps.writeFile,
        });
        const result = await flow.execute({ input: { sprintId, projectId: selection.projectId, outputPath } });
        if (!result.ok) return { ok: false, message: result.error.error.message };
        const out = result.value.ctx.output!;
        return { ok: true, path: String(out.outputPath), bytes: out.byteCount };
      }}
    />
  );
};
