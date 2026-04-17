/**
 * RefinePhaseView — detail screen for the Refine phase.
 *
 * Lists the current sprint's tickets with their `requirementStatus` badge,
 * offers a "Refine pending requirements" action button on draft sprints, and
 * shows the last run's `StepExecutionRecord[]` after the user fires it.
 *
 * Static for this commit — Commit C subscribes to `logEventBus` /
 * session-stream bus to show live AI output while the refine pipeline is
 * running.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Sprint } from '@src/domain/models.ts';
import type { StepExecutionRecord } from '@src/business/pipeline/types.ts';
import { getSharedDeps } from '@src/application/bootstrap.ts';
import { createRefinePipeline } from '@src/application/factories.ts';
import { executePipeline } from '@src/business/pipeline/pipeline.ts';
import { inkColors } from '@src/integration/ui/tui/theme/tokens.ts';
import { PhaseRunTrace } from './phase-run-trace.tsx';

interface Props {
  readonly sprintId: string;
}

interface State {
  sprint: Sprint | null;
  records: readonly StepExecutionRecord[];
  running: boolean;
  error: string | null;
}

function initialState(): State {
  return { sprint: null, records: [], running: false, error: null };
}

export function RefinePhaseView({ sprintId }: Props): React.JSX.Element {
  const shared = getSharedDeps();
  const [state, setState] = useState<State>(initialState);

  // Load sprint once on mount, and reload after a refine run settles so the
  // ticket list reflects the updated `requirementStatus` values.
  const loadSprint = useCallback(async (): Promise<void> => {
    try {
      const sprint = await shared.persistence.getSprint(sprintId);
      setState((s) => ({ ...s, sprint, error: null }));
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
    }
  }, [shared, sprintId]);

  useEffect(() => {
    void loadSprint();
  }, [loadSprint]);

  const runRefine = useCallback(async (): Promise<void> => {
    setState((s) => ({ ...s, running: true, error: null, records: [] }));
    try {
      const pipeline = createRefinePipeline(shared);
      const result = await executePipeline(pipeline, { sprintId });
      if (result.ok) {
        setState((s) => ({ ...s, records: result.value.stepResults }));
      } else {
        setState((s) => ({
          ...s,
          error: result.error.message,
          // Even on failure, stepResults aren't on the error path — leave empty.
        }));
      }
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setState((s) => ({ ...s, running: false }));
      await loadSprint();
    }
  }, [shared, sprintId, loadSprint]);

  // Enter triggers the refine action when it's applicable and the view isn't
  // already running.
  useInput(
    (_input, key) => {
      if (key.return && !state.running && canRefine(state.sprint)) {
        void runRefine();
      }
    },
    { isActive: !state.running }
  );

  if (state.sprint === null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{state.error ?? 'Loading sprint…'}</Text>
      </Box>
    );
  }

  const sprint = state.sprint;
  const pending = sprint.tickets.filter((t) => t.requirementStatus === 'pending').length;
  const approved = sprint.tickets.length - pending;
  const hasTickets = sprint.tickets.length > 0;
  const refineAvailable = canRefine(sprint);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={inkColors.primary}>
          Refine — {sprint.name}
        </Text>
        <Text dimColor>{`  (${sprint.status})`}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {`${String(approved)}/${String(sprint.tickets.length)} tickets approved`}
          {pending > 0 ? `  ·  ${String(pending)} pending` : null}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold dimColor>
          Tickets
        </Text>
        {hasTickets ? (
          sprint.tickets.map((t) => (
            <Box key={t.id} paddingLeft={2}>
              <Text color={t.requirementStatus === 'approved' ? inkColors.success : inkColors.warning} bold>
                {t.requirementStatus === 'approved' ? '✓' : '○'}
              </Text>
              <Text>{` ${t.title}`}</Text>
              <Text dimColor>{`  (${t.projectName})`}</Text>
            </Box>
          ))
        ) : (
          <Box paddingLeft={2}>
            <Text dimColor>(no tickets yet)</Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        {state.running ? (
          <Text color={inkColors.warning} bold>
            ⋯ Running refine pipeline…
          </Text>
        ) : refineAvailable ? (
          <Text color={inkColors.highlight} bold>
            ▶ Press Enter to refine pending requirements
          </Text>
        ) : (
          <Text dimColor>
            {reasonUnavailable(sprint)}
          </Text>
        )}
      </Box>

      {state.error ? (
        <Box marginTop={1}>
          <Text color={inkColors.error}>✗ {state.error}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <PhaseRunTrace records={state.records} title="Last refine run" />
      </Box>
    </Box>
  );
}

function canRefine(sprint: Sprint | null): boolean {
  if (sprint === null) return false;
  if (sprint.status !== 'draft') return false;
  if (sprint.tickets.length === 0) return false;
  return sprint.tickets.some((t) => t.requirementStatus === 'pending');
}

function reasonUnavailable(sprint: Sprint): string {
  if (sprint.status !== 'draft') return `Refine requires a draft sprint (this one is ${sprint.status}).`;
  if (sprint.tickets.length === 0) return 'Add at least one ticket before refining.';
  return 'All requirements already approved.';
}
