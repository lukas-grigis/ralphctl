/**
 * ClosePhaseView — detail screen for the Close phase.
 *
 * Shows a completion summary (done/total tasks, branch, duration), and
 * offers "Close Sprint" (plus an optional "Close + Create PRs" when the
 * sprint has a branch set) as actions. Dispatches through the existing
 * `commandMap.sprint.close` / `'close --create-pr'` entries so the PR
 * creation flow in `sprint/close.ts` is reused verbatim.
 *
 * Static for this commit — no streaming layer is added (close doesn't spawn
 * an AI session).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Sprint, Tasks } from '@src/domain/models.ts';
import { getSharedDeps } from '@src/application/bootstrap.ts';
import { inkColors } from '@src/integration/ui/tui/theme/tokens.ts';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';
import { commandMap } from '@src/integration/ui/tui/views/command-map.ts';

interface Props {
  readonly sprintId: string;
}

interface State {
  sprint: Sprint | null;
  tasks: Tasks;
  running: boolean;
  error: string | null;
}

type ActionId = 'close' | 'close-with-pr';

function initialState(): State {
  return { sprint: null, tasks: [], running: false, error: null };
}

export function ClosePhaseView({ sprintId }: Props): React.JSX.Element {
  const shared = getSharedDeps();
  const router = useRouter();
  const [state, setState] = useState<State>(initialState);
  const [cursor, setCursor] = useState(0);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [sprint, tasks] = await Promise.all([
        shared.persistence.getSprint(sprintId),
        shared.persistence.getTasks(sprintId),
      ]);
      setState((s) => ({ ...s, sprint, tasks, error: null }));
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
    }
  }, [shared, sprintId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Available actions depend on the sprint's branch + status.
  const actions = useMemo<ActionId[]>(() => {
    const sprint = state.sprint;
    if (sprint?.status !== 'active') return [];
    const base: ActionId[] = ['close'];
    if (sprint.branch) base.push('close-with-pr');
    return base;
  }, [state.sprint]);

  const runAction = useCallback(
    async (id: ActionId): Promise<void> => {
      const key = id === 'close-with-pr' ? 'close --create-pr' : 'close';
      const handler = commandMap['sprint']?.[key];
      if (!handler) {
        setState((s) => ({ ...s, error: `Unknown action: sprint ${key}` }));
        return;
      }
      setState((s) => ({ ...s, running: true, error: null }));
      try {
        await handler();
        // On success the sprint is closed — bounce home so the pipeline map
        // reflects the new state.
        router.reset({ id: 'home' });
      } catch (err) {
        if (err instanceof Error && err.name !== 'PromptCancelledError') {
          setState((s) => ({ ...s, error: err.message }));
        }
      } finally {
        setState((s) => ({ ...s, running: false }));
        await load();
      }
    },
    [router, load]
  );

  useInput(
    (_input, key) => {
      if (state.running || actions.length === 0) return;
      if (key.upArrow) {
        setCursor((c) => (c === 0 ? actions.length - 1 : c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (c === actions.length - 1 ? 0 : c + 1));
        return;
      }
      if (key.return) {
        const selected = actions[cursor];
        if (selected) void runAction(selected);
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
  const tasks = state.tasks;
  const done = tasks.filter((t) => t.status === 'done').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const todo = tasks.filter((t) => t.status === 'todo').length;
  const total = tasks.length;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={inkColors.primary}>
          Close — {sprint.name}
        </Text>
        <Text dimColor>{`  (${sprint.status})`}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold dimColor>
          Completion summary
        </Text>
        <Box paddingLeft={2}>
          <Text color={inkColors.success}>{`${String(done)} done`}</Text>
          <Text dimColor>{'  ·  '}</Text>
          <Text color={inkColors.warning}>{`${String(inProgress)} in progress`}</Text>
          <Text dimColor>{'  ·  '}</Text>
          <Text dimColor>{`${String(todo)} todo`}</Text>
          <Text dimColor>{`  ·  ${String(total)} total`}</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text dimColor>
            Branch: {sprint.branch ?? '(none — no PRs will be offered)'}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold dimColor>
          Actions
        </Text>
        {sprint.status !== 'active' ? (
          <Box paddingLeft={2}>
            <Text dimColor>{`This sprint is ${sprint.status}. Nothing to close.`}</Text>
          </Box>
        ) : (
          actions.map((id, i) => {
            const selected = i === cursor;
            const label = id === 'close-with-pr' ? 'Close Sprint + Create PRs' : 'Close Sprint';
            return (
              <Box key={id} paddingLeft={2}>
                <Text color={selected ? inkColors.highlight : undefined} bold={selected}>
                  {selected ? '▶ ' : '  '}
                  {label}
                </Text>
              </Box>
            );
          })
        )}
      </Box>

      {state.running ? (
        <Box marginTop={1}>
          <Text color={inkColors.warning} bold>
            ⋯ Closing sprint…
          </Text>
        </Box>
      ) : null}

      {state.error ? (
        <Box marginTop={1}>
          <Text color={inkColors.error}>✗ {state.error}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>↑/↓ select action · Enter confirm · Esc back</Text>
      </Box>
    </Box>
  );
}
