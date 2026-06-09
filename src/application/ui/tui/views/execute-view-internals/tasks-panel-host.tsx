/**
 * Adapter that wires the live bucketed-task derivation into the shared `TasksPanel`. Folds
 * three concerns the orchestrator would otherwise carry inline:
 *
 *   - Translates the `Task.verificationCriteria` array into per-task bullet strings (the
 *     panel renders one criterion per line; audit-[05] says `Task.verificationCriteria`
 *     is the canonical source — never read `done-criteria.md`).
 *   - Forwards optional descriptor maps (`taskNames`, `taskRecovering`) only when present
 *     so the panel's prop diff stays clean.
 *   - Returns `null` when no bucket has been produced yet (early descriptor / no session),
 *     keeping the orchestrator's JSX a single expression.
 */

import React, { useMemo } from 'react';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { AttemptWarning } from '@src/domain/entity/attempt.ts';
import type { Task } from '@src/domain/entity/task.ts';

/** One-line summary for a flagged completion shown under the task card. Kind-specific prose. */
const warningSummaryFor = (w: AttemptWarning): string => {
  switch (w.kind) {
    case 'budget-exhausted':
      return `done with warning: turn budget exhausted (${String(w.turnsUsed)}/${String(w.turnBudget)} turns)`;
    case 'plateau':
      return w.dimensions.length > 0
        ? `done with warning: evaluator plateaued on ${w.dimensions.join(', ')}`
        : 'done with warning: evaluator plateaued';
    case 'malformed':
      return 'done with warning: evaluator output malformed';
    case 'verify-failed':
      return `done with warning: post-task verify red (${w.exitCode !== null ? `exit ${String(w.exitCode)}` : 'no exit code'})`;
  }
};

interface TasksPanelHostProps {
  readonly bucketed: BucketedExecution | undefined;
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly maxSignalsPerTask: number;
  /** Card-count budget for the windowed Tasks column (from `layout.tasksMaxBlocks`). */
  readonly maxTasks: number;
  readonly inputActive: boolean;
  readonly now: number;
  readonly taskState: readonly Task[] | undefined;
}

export const TasksPanelHost = ({
  bucketed,
  descriptor,
  isRunning,
  maxSignalsPerTask,
  maxTasks,
  inputActive,
  now,
  taskState,
}: TasksPanelHostProps): React.JSX.Element | null => {
  const taskCriteriaById = useMemo<ReadonlyMap<string, readonly string[]> | undefined>(() => {
    if (taskState === undefined) return undefined;
    const m = new Map<string, readonly string[]>();
    for (const t of taskState) {
      const bullets = t.verificationCriteria.map((c) =>
        c.check === 'auto' && c.command !== undefined
          ? `[${c.id}] auto \`${c.command}\` — ${c.assertion}`
          : `[${c.id}] manual — ${c.assertion}`
      );
      m.set(String(t.id), bullets);
    }
    return m;
  }, [taskState]);

  // taskId → blockedReason for blocked tasks, so the panel can render WHY a card blocked. The
  // live TaskBucket status is trace-derived and carries no reason; the reason lives on the polled
  // entity. Undefined when no task is blocked (keeps the panel's prop diff clean).
  const blockedReasonById = useMemo<ReadonlyMap<string, string> | undefined>(() => {
    if (taskState === undefined) return undefined;
    const m = new Map<string, string>();
    for (const t of taskState) {
      if (t.status === 'blocked') m.set(String(t.id), t.blockedReason);
    }
    return m.size > 0 ? m : undefined;
  }, [taskState]);

  // taskId → one-line summary for a done task whose FINAL attempt carries a warning. Mirrors the
  // blocked-reason map: the live TaskBucket is trace-derived and carries no warning, so the data
  // comes off the polled entity. Undefined when every done task landed clean (clean prop diff).
  const warningSummaryById = useMemo<ReadonlyMap<string, string> | undefined>(() => {
    if (taskState === undefined) return undefined;
    const m = new Map<string, string>();
    for (const t of taskState) {
      if (t.status !== 'done') continue;
      const warning = t.attempts[t.attempts.length - 1]?.warning;
      if (warning !== undefined) m.set(String(t.id), warningSummaryFor(warning));
    }
    return m.size > 0 ? m : undefined;
  }, [taskState]);

  if (bucketed === undefined) return null;

  return (
    <TasksPanel
      bucketed={bucketed}
      running={isRunning}
      maxSignalsPerTask={maxSignalsPerTask}
      maxTasks={maxTasks}
      inputActive={inputActive}
      nowMs={now}
      {...(descriptor.taskNames !== undefined ? { nameById: descriptor.taskNames } : {})}
      {...(descriptor.taskRecovering !== undefined ? { recoveringByTaskId: descriptor.taskRecovering } : {})}
      {...(taskCriteriaById !== undefined ? { taskCriteriaById } : {})}
      {...(blockedReasonById !== undefined ? { blockedReasonById } : {})}
      {...(warningSummaryById !== undefined ? { warningSummaryById } : {})}
    />
  );
};
