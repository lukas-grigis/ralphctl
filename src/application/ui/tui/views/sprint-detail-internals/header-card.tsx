/**
 * Sprint-detail header — the bordered card at the top of the view, its inline phase ribbon, and
 * the phase-aware "Next phase" card that sits immediately below.
 *
 * Renders the sprint name, status chip, slug, ticket / task counts, the phase timeline (with
 * elapsed-between-transitions), and the pipeline map. The companion `NextPhaseCard` suggests
 * the operator's next action — "Add tickets", "Refine N pending ticket(s)", … — keyed off the
 * sprint status; its projection logic (`phaseAction`) is exported so non-rendering surfaces can
 * reuse it without pulling in Ink.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { PipelineMap } from '@src/application/ui/tui/components/pipeline-map.tsx';
import { sprintStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtDuration, fmtIsoAbsolute } from '@src/application/ui/tui/theme/duration.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';

export const SprintHeader = ({
  sprint,
  tasks,
  isCurrent,
}: {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly isCurrent: boolean;
}): React.JSX.Element => {
  const done = tasks.filter((t) => t.status === 'done').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  // The `· current` badge lives on the right next to the status chip — Card's `title` is a
  // plain string, and stacking the badge alongside the chip keeps the right rail expressing
  // selection + lifecycle in one glance without overloading either onto the title slot.
  const rightSide = (
    <Box>
      {isCurrent && (
        <Text dimColor italic>
          {glyphs.bullet} current{'  '}
        </Text>
      )}
      <StatusChip label={sprint.status} kind={sprintStatusKind(sprint.status)} />
    </Box>
  );
  return (
    <Card title={sprint.name} tone="primary" right={rightSide}>
      <FieldList
        fields={[
          { label: 'Slug', value: sprint.slug },
          { label: 'Tickets', value: String(sprint.tickets.length) },
          {
            label: 'Tasks',
            value: `${String(tasks.length)}  (${String(done)} done · ${String(blocked)} blocked)`,
          },
        ]}
      />
      <Box marginTop={spacing.section}>
        <PhaseTimeline sprint={sprint} />
      </Box>
      <Box marginTop={spacing.section}>
        <PipelineMap status={sprint.status} />
      </Box>
    </Card>
  );
};

/**
 * Inline phase ribbon with elapsed-between-transitions. We can't show the draft duration —
 * sprints don't carry a `createdAt` — but every later transition timestamp is on the entity,
 * so the ribbon reads like `planned · 2025-05-10  → active · 3h  → review · 1d2h  → done · 4h`.
 * When a phase is the current one (no later timestamp), it shows `ongoing for X` instead.
 *
 * Robust to test fixtures that store `undefined` instead of `null` for unreached phases: both
 * are filtered out via `!= null` (the loose equality on purpose).
 */
const PhaseTimeline = ({ sprint }: { readonly sprint: Sprint }): React.JSX.Element => {
  const now = Date.now();
  interface PhaseDef {
    readonly label: string;
    readonly at: string | null | undefined;
    readonly nextAt: string | null | undefined;
  }
  const phases: readonly PhaseDef[] = [
    { label: 'planned', at: sprint.plannedAt, nextAt: sprint.activatedAt },
    { label: 'active', at: sprint.activatedAt, nextAt: sprint.reviewAt },
    { label: 'review', at: sprint.reviewAt, nextAt: sprint.doneAt },
    { label: 'done', at: sprint.doneAt, nextAt: null },
  ];
  const hasAt = (p: PhaseDef): p is PhaseDef & { readonly at: string } => p.at !== null && p.at !== undefined;
  const noNextAt = (next: string | null | undefined): boolean => next === null || next === undefined;
  const cells = phases.filter(hasAt).map((p, i, all) => {
    const sameAsLast = i === all.length - 1;
    const startedMs = Date.parse(p.at);
    const elapsedMs = (() => {
      if (!noNextAt(p.nextAt)) {
        const ended = Date.parse(p.nextAt!);
        return Number.isFinite(ended) && Number.isFinite(startedMs) ? ended - startedMs : undefined;
      }
      if (sameAsLast && sprint.status !== 'done') {
        return Number.isFinite(startedMs) ? now - startedMs : undefined;
      }
      return undefined;
    })();
    return {
      label: p.label,
      absolute: fmtIsoAbsolute(p.at),
      elapsed: elapsedMs !== undefined ? fmtDuration(elapsedMs) : undefined,
      ongoing: noNextAt(p.nextAt) && sprint.status !== 'done',
    };
  });
  if (cells.length === 0) {
    return (
      <Text dimColor>
        {glyphs.bullet} draft {glyphs.bullet} no transitions yet
      </Text>
    );
  }
  return (
    <Box flexDirection="column" paddingLeft={spacing.indent}>
      {cells.map((c, idx) => (
        <Box key={`${c.label}-${String(idx)}`}>
          <Text dimColor>{glyphs.activityArrow} </Text>
          <Text bold>{c.label}</Text>
          <Text dimColor>
            {' '}
            {glyphs.bullet} {c.absolute}
          </Text>
          {c.elapsed !== undefined && (
            <Text color={c.ongoing ? inkColors.info : inkColors.muted}>
              {' '}
              {glyphs.bullet} {c.ongoing ? 'ongoing ' : 'lasted '}
              {c.elapsed}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
};

interface PhaseAction {
  readonly label: string;
  readonly hint: string;
}

export const phaseAction = (sprint: Sprint, tasks: readonly Task[]): PhaseAction | undefined => {
  const pending = sprint.tickets.filter((t) => t.status === 'pending').length;
  const approved = sprint.tickets.filter((t) => t.status === 'approved').length;
  const todo = tasks.filter((t) => t.status === 'todo').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  // Both `todo` and `in_progress` tasks are resumable on the next implement launch — an
  // `in_progress` task is one left mid-run by a prior crash and is reset to `todo` on relaunch.
  // Counting only `todo` here contradicted Home (which counts both) for crash-resumed sprints.
  const resumable = todo + inProgress;
  switch (sprint.status) {
    case 'draft':
      if (sprint.tickets.length === 0) {
        return { label: 'Add tickets', hint: 'Press a to start adding inputs to this sprint.' };
      }
      if (pending > 0) {
        return {
          label: `Refine ${String(pending)} pending ticket(s)`,
          hint: 'Press n → refine. Tickets become inputs for plan once approved.',
        };
      }
      if (approved > 0) {
        return {
          label: `Plan ${String(approved)} approved ticket(s)`,
          hint: 'Press n → plan. Generates a dependency-ordered task list.',
        };
      }
      return undefined;
    case 'planned':
    case 'active':
      if (resumable > 0) {
        return {
          label: `Implement ${String(resumable)} resumable task(s)`,
          hint: 'Press n → implement. The loop picks tasks in dependency order and commits as it goes.',
        };
      }
      return { label: 'Review pending tasks', hint: 'No pending tasks — check the list below for blocked / done.' };
    case 'review':
      return {
        label: 'Open a pull request, then close',
        hint: 'Press n → create-pr to surface for human approval, then n → close-sprint when you are done.',
      };
    case 'done':
      return {
        label: 'Sprint closed',
        hint: 'No further work happens here. Press S to switch to another sprint.',
      };
  }
};

export const NextPhaseCard = ({
  sprint,
  tasks,
}: {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
}): React.JSX.Element | null => {
  const action = phaseAction(sprint, tasks);
  if (action === undefined) return null;
  if (sprint.status === 'done') {
    return (
      <Box paddingX={spacing.indent} marginTop={spacing.section}>
        <Text dimColor>
          {glyphs.check} {action.hint}
        </Text>
      </Box>
    );
  }
  // When the only remaining work is partially-complete (`in_progress`, no fresh `todo`), the
  // sprint was left mid-run by a prior crash. Call out that the next launch resumes that work
  // so the operator doesn't read "Implement" as starting from scratch.
  const todo = tasks.filter((t) => t.status === 'todo').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const isResume = (sprint.status === 'planned' || sprint.status === 'active') && inProgress > 0 && todo === 0;
  return (
    <Box marginTop={spacing.section}>
      <Card title="Next phase" tone="primary">
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text bold color={inkColors.primary}>
            {glyphs.actionCursor} {action.label}
          </Text>
          <Box marginTop={spacing.section}>
            <Text dimColor>{action.hint}</Text>
          </Box>
          {isResume && (
            <Box marginTop={spacing.section}>
              <Text dimColor>
                {glyphs.actionCursor} Resume in-progress task {glyphs.emDash} {String(inProgress)} task(s) partially
                complete from a prior run; press n {glyphs.arrowRight} implement to resume.
              </Text>
            </Box>
          )}
        </Box>
      </Card>
    </Box>
  );
};
