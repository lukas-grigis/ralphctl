/**
 * Export-requirements view — runs the export-requirements flow for the selected sprint and
 * reports where the markdown was written. A thin wrapper over {@link MarkdownExportView}, which
 * owns the shared one-shot run lifecycle (run token, sprint-dir resolution, `r` re-run).
 *
 * Output convention matches the other per-sprint artifacts (context.md, plan/, refinement/):
 *   `<dataRoot>/sprints/<sprintId>/requirements.md`
 */

import React from 'react';
import { MarkdownExportView } from '@src/application/ui/tui/views/markdown-export-view.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { createExportRequirementsFlow } from '@src/application/flows/export-requirements/flow.ts';

export const ExportRequirementsView = (): React.JSX.Element => {
  const deps = useDeps();
  const selection = useSelection();

  return (
    <MarkdownExportView
      title="Export requirements"
      subtitle="approved-ticket requirements → markdown"
      spinnerLabel="Writing requirements markdown…"
      filename="requirements.md"
      deps={[deps, selection.sprintId]}
      run={async ({ outputPath, sprintId }) => {
        const flow = createExportRequirementsFlow({ sprintRepo: deps.sprintRepo, writeFile: deps.writeFile });
        const result = await flow.execute({ input: { sprintId, outputPath } });
        if (!result.ok) return { ok: false, message: result.error.error.message };
        const out = result.value.ctx.output!;
        return { ok: true, path: String(out.outputPath), bytes: out.byteCount };
      }}
    />
  );
};
