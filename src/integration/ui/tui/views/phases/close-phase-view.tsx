/**
 * ClosePhaseView — detail screen for the Close phase.
 *
 * Shows a completion summary (done/total tasks, branch, duration), and
 * offers "Close Sprint" (plus an optional "Close + Create PRs" when the
 * sprint has a branch set) as actions.
 *
 * Native Ink flow: hits `closeSprint()` directly and — for the PR variant —
 * drives the `git push` / `gh pr create` calls itself so no raw `console.log`
 * from the old CLI command reaches the alt-screen buffer.
 */

import { spawnSync } from 'node:child_process';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Sprint, Tasks } from '@src/domain/models.ts';
import { getSharedDeps, getPrompt } from '@src/integration/bootstrap.ts';
import { PromptCancelledError } from '@src/business/ports/prompt.ts';
import { closeSprint, getSprint } from '@src/integration/persistence/sprint.ts';
import { areAllTasksDone, listTasks } from '@src/integration/persistence/task.ts';
import { resolveRepoPath } from '@src/integration/persistence/project.ts';
import { branchExists, getDefaultBranch, isGhAvailable } from '@src/integration/external/git.ts';
import { assertSafeCwd } from '@src/integration/persistence/paths.ts';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';

const HINTS_READY = [
  { key: '↑/↓', action: 'select' },
  { key: 'Enter', action: 'confirm' },
  { key: 'Esc', action: 'back' },
] as const;
const HINTS_TERMINAL = [{ key: 'Enter', action: 'home' }] as const;
const HINTS_WORKING = [] as const;

interface Props {
  readonly sprintId: string;
}

type ActionId = 'close' | 'close-with-pr';

interface PrResult {
  readonly projectPath: string;
  readonly status: 'created' | 'skipped' | 'failed';
  readonly message: string;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'running'; label: string }
  | { kind: 'done'; sprint: Sprint; prResults: readonly PrResult[] }
  | { kind: 'error'; message: string };

interface State {
  sprint: Sprint | null;
  tasks: Tasks;
  phase: Phase;
}

function initial(): State {
  return { sprint: null, tasks: [], phase: { kind: 'loading' } };
}

export function ClosePhaseView({ sprintId }: Props): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<State>(initial);
  const [cursor, setCursor] = useState(0);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [sprint, tasks] = await Promise.all([
        getSharedDeps().persistence.getSprint(sprintId),
        getSharedDeps().persistence.getTasks(sprintId),
      ]);
      setState((s) => ({ ...s, sprint, tasks, phase: { kind: 'ready' } }));
    } catch (err) {
      setState((s) => ({
        ...s,
        phase: { kind: 'error', message: err instanceof Error ? err.message : String(err) },
      }));
    }
  }, [sprintId]);

  useEffect(() => {
    void load();
  }, [load]);

  const actions = useMemo<ActionId[]>(() => {
    const sprint = state.sprint;
    if (sprint?.status !== 'active') return [];
    const base: ActionId[] = ['close'];
    if (sprint.branch) base.push('close-with-pr');
    return base;
  }, [state.sprint]);

  const closeFlow = useCallback(
    async (createPrs: boolean): Promise<void> => {
      if (state.sprint === null) return;
      try {
        const allDone = await areAllTasksDone(sprintId);
        if (!allDone) {
          const tasks = await listTasks(sprintId);
          const remaining = tasks.filter((t) => t.status !== 'done').length;
          const proceed = await getPrompt().confirm({
            message: `${String(remaining)} task(s) not done — close sprint anyway?`,
            default: false,
          });
          if (!proceed) {
            setState((s) => ({ ...s, phase: { kind: 'ready' } }));
            return;
          }
        }

        setState((s) => ({ ...s, phase: { kind: 'running', label: 'Closing sprint…' } }));

        const sprintBefore = await getSprint(sprintId);
        const closed = await closeSprint(sprintId);
        let prResults: readonly PrResult[] = [];

        if (createPrs && sprintBefore.branch) {
          setState((s) => ({ ...s, phase: { kind: 'running', label: 'Creating PRs…' } }));
          prResults = await createPullRequests(sprintId, sprintBefore.branch, closed.name);
        }

        setState((s) => ({ ...s, sprint: closed, phase: { kind: 'done', sprint: closed, prResults } }));
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          setState((s) => ({ ...s, phase: { kind: 'ready' } }));
          return;
        }
        setState((s) => ({
          ...s,
          phase: { kind: 'error', message: err instanceof Error ? err.message : String(err) },
        }));
      }
    },
    [sprintId, state.sprint]
  );

  useInput(
    (_input, key) => {
      const { phase } = state;
      if (phase.kind === 'done' || phase.kind === 'error') {
        // Enter returns home. Esc is handled globally by the router.
        if (key.return) router.pop();
        return;
      }
      if (phase.kind !== 'ready') return;
      if (actions.length === 0) {
        // Terminal state (already-closed sprint has nothing to confirm).
        // Enter pops back instead of silently doing nothing.
        if (key.return) router.pop();
        return;
      }
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
        if (selected) void closeFlow(selected === 'close-with-pr');
      }
    },
    { isActive: state.phase.kind !== 'running' && state.phase.kind !== 'loading' }
  );

  const phaseKind = state.phase.kind;
  const activeHints =
    phaseKind === 'running' || phaseKind === 'loading'
      ? HINTS_WORKING
      : phaseKind === 'done' || phaseKind === 'error' || actions.length === 0
        ? HINTS_TERMINAL
        : HINTS_READY;
  useViewHints(activeHints);

  if (state.sprint === null) {
    return (
      <ViewShell title="Close Phase">
        <Text dimColor>{state.phase.kind === 'error' ? state.phase.message : 'Loading sprint…'}</Text>
      </ViewShell>
    );
  }

  const sprint = state.sprint;
  const { phase, tasks } = state;
  const done = tasks.filter((t) => t.status === 'done').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const todo = tasks.filter((t) => t.status === 'todo').length;
  const total = tasks.length;

  return (
    <ViewShell title="Close Phase">
      <Box>
        <Text bold color={inkColors.primary}>
          Close — {sprint.name}
        </Text>
        <Text dimColor>{`  (${sprint.status})`}</Text>
      </Box>

      <Box marginTop={spacing.section} flexDirection="column">
        <Text bold dimColor>
          Completion summary
        </Text>
        <Box paddingLeft={spacing.indent}>
          <Text color={inkColors.success}>{`${String(done)} done`}</Text>
          <Text dimColor>{`  ${glyphs.inlineDot}  `}</Text>
          <Text color={inkColors.warning}>{`${String(inProgress)} in progress`}</Text>
          <Text dimColor>{`  ${glyphs.inlineDot}  `}</Text>
          <Text dimColor>{`${String(todo)} todo`}</Text>
          <Text dimColor>{`  ${glyphs.inlineDot}  ${String(total)} total`}</Text>
        </Box>
        <Box paddingLeft={spacing.indent}>
          <Text dimColor>Branch: {sprint.branch ?? '(none — no PRs will be offered)'}</Text>
        </Box>
      </Box>

      <Box marginTop={spacing.section} flexDirection="column">
        <Text bold dimColor>
          Actions
        </Text>
        {renderActions(phase, actions, cursor, sprint)}
      </Box>

      {phase.kind === 'running' ? (
        <Box marginTop={spacing.section}>
          <Text color={inkColors.warning} bold>
            ⋯ {phase.label}
          </Text>
        </Box>
      ) : null}

      {phase.kind === 'done' ? (
        <Box marginTop={spacing.section} flexDirection="column">
          <ResultCard
            kind="success"
            title="Sprint closed"
            fields={[
              ['ID', phase.sprint.id],
              ['Name', phase.sprint.name],
            ]}
          />
          {phase.prResults.length > 0 ? (
            <Box marginTop={spacing.section} flexDirection="column">
              <Text bold dimColor>
                PR results
              </Text>
              {phase.prResults.map((r) => (
                <Box key={r.projectPath} paddingLeft={spacing.indent}>
                  <Text color={prColor(r.status)}>{prGlyph(r.status)}</Text>
                  <Text dimColor>{` ${r.projectPath}  `}</Text>
                  <Text>{r.message}</Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      ) : null}

      {phase.kind === 'error' ? (
        <Box marginTop={spacing.section}>
          <ResultCard kind="error" title="Close failed" lines={[phase.message]} />
        </Box>
      ) : null}
    </ViewShell>
  );
}

function renderActions(phase: Phase, actions: readonly ActionId[], cursor: number, sprint: Sprint): React.JSX.Element {
  if (sprint.status !== 'active') {
    return (
      <Box paddingLeft={spacing.indent}>
        <Text dimColor>{`This sprint is ${sprint.status}. Nothing to close.`}</Text>
      </Box>
    );
  }
  if (phase.kind === 'done' || phase.kind === 'error') {
    return (
      <Box paddingLeft={spacing.indent}>
        <Text dimColor>(completed)</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {actions.map((id, i) => {
        const selected = i === cursor;
        const label = id === 'close-with-pr' ? 'Close Sprint + Create PRs' : 'Close Sprint';
        return (
          <Box key={id} paddingLeft={spacing.indent}>
            <Text color={selected ? inkColors.highlight : undefined} bold={selected}>
              {selected ? `${glyphs.actionCursor} ` : '  '}
              {label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function prColor(status: PrResult['status']): string {
  if (status === 'created') return inkColors.success;
  if (status === 'failed') return inkColors.error;
  return inkColors.muted;
}

function prGlyph(status: PrResult['status']): string {
  if (status === 'created') return glyphs.check;
  if (status === 'failed') return glyphs.cross;
  return glyphs.inlineDot;
}

async function createPullRequests(
  sprintId: string,
  branchName: string,
  sprintName: string
): Promise<readonly PrResult[]> {
  if (!isGhAvailable()) {
    return [
      {
        projectPath: '(global)',
        status: 'skipped',
        message: `gh not found. Manual: gh pr create --head ${branchName} --title "Sprint: ${sprintName}"`,
      },
    ];
  }

  const tasks = await listTasks(sprintId);
  const uniqueRepoIds = [...new Set(tasks.map((t) => t.repoId))];
  const uniquePaths: string[] = [];
  for (const repoId of uniqueRepoIds) {
    const p = await resolveRepoPath(repoId).catch(() => null);
    if (p) uniquePaths.push(p);
  }
  const results: PrResult[] = [];

  for (const projectPath of uniquePaths) {
    try {
      assertSafeCwd(projectPath);
    } catch (err) {
      results.push({
        projectPath,
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!branchExists(projectPath, branchName)) {
      results.push({ projectPath, status: 'skipped', message: `Branch '${branchName}' not found.` });
      continue;
    }
    const baseBranch = getDefaultBranch(projectPath);
    const title = `Sprint: ${sprintName}`;

    const pushResult = spawnSync('git', ['push', '-u', 'origin', branchName], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (pushResult.status !== 0) {
      results.push({
        projectPath,
        status: 'failed',
        message: `git push failed: ${pushResult.stderr.trim()}`,
      });
      continue;
    }

    const ghResult = spawnSync(
      'gh',
      [
        'pr',
        'create',
        '--base',
        baseBranch,
        '--head',
        branchName,
        '--title',
        title,
        '--body',
        `Sprint: ${sprintName}\nID: ${sprintId}`,
      ],
      { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    if (ghResult.status === 0) {
      results.push({ projectPath, status: 'created', message: ghResult.stdout.trim() });
    } else {
      results.push({
        projectPath,
        status: 'failed',
        message: `gh pr create failed: ${ghResult.stderr.trim()}`,
      });
    }
  }
  return results;
}
