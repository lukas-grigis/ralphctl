/**
 * ProgressView — sprint progress + diagnostics in one panel.
 *
 * Folds blockers, stale tasks, dependency cycles, and branch consistency
 * into the same surface as the timeline tail. Read-only — Esc returns
 * to the previous view.
 */
import React, { useEffect, useState } from 'react';
import { join } from 'node:path';
import { Box, Text } from 'ink';

import { glyphs, inkColors, spacing } from '../../../../integration/ui/theme/tokens.ts';
import { ViewShell } from '../../components/view-shell.tsx';
import { Spinner } from '../../components/spinner.tsx';
import { ResultCard } from '../../components/result-card.tsx';
import { FieldList } from '../../components/field-list.tsx';
import { useViewHints } from '../view-hints-context.tsx';
import { getSharedDeps } from '../../../bootstrap/get-shared-deps.ts';
import {
  ShowProgressUseCase,
  STALE_THRESHOLD_HOURS,
  type ProgressReport,
} from '../../../../business/usecases/sprint/show-progress.ts';
import { IsoTimestamp } from '../../../../domain/values/iso-timestamp.ts';

const HINTS = [{ key: 'Esc', action: 'back' }] as const;
const TAIL_LIMIT = 50;

export function ProgressView(): React.JSX.Element {
  useViewHints(HINTS);
  const [report, setReport] = useState<ProgressReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cancel = { current: false };
    void (async () => {
      try {
        const deps = await getSharedDeps();
        const cfg = await deps.configStore.load();
        if (!cfg.ok) {
          if (!cancel.current) setError(cfg.error.message);
          return;
        }
        const sprintId = cfg.value.currentSprint;
        if (sprintId === null) {
          if (!cancel.current) setError('No current sprint set.');
          return;
        }
        const uc = new ShowProgressUseCase(
          deps.sprintRepo,
          deps.taskRepo,
          deps.projectRepo,
          deps.external,
          undefined,
          (id) => join(String(deps.storage.sprintsDir), String(id), 'progress.md')
        );
        const result = await uc.execute({ sprintId, now: IsoTimestamp.now() });
        if (cancel.current) return;
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setReport(result.value);
      } catch (err) {
        if (!cancel.current) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancel.current = true;
    };
  }, []);

  if (report === null && error === null) {
    return (
      <ViewShell title="PROGRESS">
        <Spinner label="Loading progress…" />
      </ViewShell>
    );
  }

  if (error !== null) {
    return (
      <ViewShell title="PROGRESS">
        <ResultCard
          kind="warning"
          title="Cannot show progress"
          lines={[error]}
          nextSteps={[{ action: 'Press Esc to go back' }]}
        />
      </ViewShell>
    );
  }

  if (report === null) {
    return (
      <ViewShell title="PROGRESS">
        <Box />
      </ViewShell>
    );
  }

  return (
    <ViewShell title="PROGRESS">
      <Box flexDirection="column">
        <Summary report={report} />

        {report.blockers.length > 0 ? <Blockers report={report} /> : null}
        {report.staleTasks.length > 0 ? <StaleSection report={report} /> : null}
        {report.dependencyCycle !== null && report.dependencyCycle.length > 0 ? <CycleSection report={report} /> : null}
        {report.branchInconsistency.length > 0 ? <BranchSection report={report} /> : null}

        <Timeline report={report} />
      </Box>
    </ViewShell>
  );
}

function Summary({ report }: { readonly report: ProgressReport }): React.JSX.Element {
  const total = report.tasks.length;
  const done = report.tasks.filter((t) => t.status === 'done').length;
  const inProgress = report.tasks.filter((t) => t.status === 'in_progress').length;
  const fields: [string, string][] = [
    ['Sprint', report.sprintName],
    ['Status', report.sprintStatus.toUpperCase()],
    ['Tasks', `${String(done)}/${String(total)} done · ${String(inProgress)} in progress`],
  ];
  return (
    <Box marginBottom={spacing.section}>
      <FieldList fields={fields} />
    </Box>
  );
}

function Blockers({ report }: { readonly report: ProgressReport }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Text color={inkColors.error} bold>
        {`${glyphs.cross} Blockers (${String(report.blockers.length)})`}
      </Text>
      {report.blockers.map((row) => (
        <Box key={String(row.task.id)} paddingLeft={spacing.indent}>
          <Text>{row.task.name}</Text>
          <Text dimColor>{` ${glyphs.emDash} ${row.reason}`}</Text>
        </Box>
      ))}
    </Box>
  );
}

function StaleSection({ report }: { readonly report: ProgressReport }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Text color={inkColors.warning} bold>
        {`${glyphs.warningGlyph} Stale tasks (>${String(STALE_THRESHOLD_HOURS)}h, ${String(report.staleTasks.length)})`}
      </Text>
      {report.staleTasks.map((row) => (
        <Box key={String(row.task.id)} paddingLeft={spacing.indent}>
          <Text>{row.task.name}</Text>
          <Text dimColor>{` ${glyphs.emDash} ${String(row.hoursStale)}h since last signal`}</Text>
        </Box>
      ))}
    </Box>
  );
}

function CycleSection({ report }: { readonly report: ProgressReport }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Text color={inkColors.error} bold>
        {`${glyphs.cross} Dependency cycle`}
      </Text>
      <Box paddingLeft={spacing.indent}>
        <Text>{(report.dependencyCycle ?? []).map((id) => String(id)).join(' → ')}</Text>
      </Box>
    </Box>
  );
}

function BranchSection({ report }: { readonly report: ProgressReport }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Text color={inkColors.warning} bold>
        {`${glyphs.warningGlyph} Branch inconsistency (${String(report.branchInconsistency.length)})`}
      </Text>
      {report.branchInconsistency.map((row) => (
        <Box key={String(row.repoPath)} paddingLeft={spacing.indent} flexDirection="column">
          <Text>{String(row.repoPath)}</Text>
          <Text dimColor>{`  expected ${row.expected} ${glyphs.emDash} actual ${row.actual}`}</Text>
        </Box>
      ))}
    </Box>
  );
}

function Timeline({ report }: { readonly report: ProgressReport }): React.JSX.Element {
  if (report.timeline.length === 0) {
    return (
      <Box>
        <Text dimColor>(no timeline entries yet)</Text>
      </Box>
    );
  }
  const tail = report.timeline.slice(Math.max(0, report.timeline.length - TAIL_LIMIT));
  return (
    <Box flexDirection="column">
      <Text bold>Timeline</Text>
      {tail.map((entry, i) => (
        <Box key={i} paddingLeft={spacing.indent}>
          {entry.timestamp.length > 0 ? <Text dimColor>{`${entry.timestamp}  `}</Text> : null}
          <Text>{entry.line}</Text>
        </Box>
      ))}
    </Box>
  );
}
