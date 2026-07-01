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
import { UUID_SUFFIX_REGEX } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { TaskEvaluation } from '@src/application/ui/tui/components/tasks-panel-internals/evaluation-row.tsx';
import type { AttemptWarning } from '@src/domain/entity/attempt.ts';
import type { Task } from '@src/domain/entity/task.ts';

/**
 * Dynamic gen-eval leaf names that repeat an unknown number of rounds. These are excluded from
 * the pending-sub-steps list so we never fabricate a fixed count of future rounds.
 */
const DYNAMIC_LEAF_NAMES = new Set(['generator', 'evaluator']);

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
    case 'crashed':
      // A `crashed` warning rides a FAILED (retried) attempt, not a done task's final attempt, so
      // this arm is unreachable through the done-only caller above — present for exhaustiveness.
      return 'retried after a process crash (watchdog/crash)';
  }
};

export interface TasksPanelHostProps {
  readonly bucketed: BucketedExecution | undefined;
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly maxSignalsPerTask: number;
  /** Card-count budget for the windowed Tasks column (from `layout.tasksMaxBlocks`). */
  readonly maxTasks: number;
  readonly inputActive: boolean;
  readonly now: number;
  readonly taskState: readonly Task[] | undefined;
  /** Optional callback — fired (deduped) when the focused card id changes. See `TasksPanel`. */
  readonly onFocusedCardChange?: (taskId: string | undefined) => void;
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
  onFocusedCardChange,
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

  // taskId → AUTHORITATIVE evaluation verdict, sourced from the task entity's attempts (keyed
  // by task id, so there is no cross-task / stale-window leak). The card renders THIS verdict —
  // never the timestamp-bucketed signal stream, which mis-attributes evaluator signals under
  // parallel/wave sprints where task windows overlap. We prefer the LAST attempt's evaluation;
  // if the last attempt has none yet, fall back to the most recent attempt that does. Undefined
  // when no task has settled an evaluation (clean prop diff, mirroring the sibling maps).
  const taskEvaluationById = useMemo<ReadonlyMap<string, TaskEvaluation> | undefined>(() => {
    if (taskState === undefined) return undefined;
    const m = new Map<string, TaskEvaluation>();
    for (const t of taskState) {
      for (let i = t.attempts.length - 1; i >= 0; i -= 1) {
        const att = t.attempts[i];
        if (att?.evaluation === undefined) continue;
        m.set(String(t.id), {
          status: att.evaluation.status,
          attemptN: att.n,
          ...(att.finishedAt !== null ? { finishedAt: att.finishedAt } : {}),
        });
        break;
      }
    }
    return m.size > 0 ? m : undefined;
  }, [taskState]);

  // Derive pending (not-yet-executed) sub-step leaf names per task from the planned leaves.
  // `descriptor.plannedLeaves` contains ALL planned leaf names including UUID-suffixed per-task
  // ones (e.g. `generator-<taskId>`, `commit-task-<taskId>`, `uninstall-skills-<taskId>`).
  //
  // Algorithm:
  //   1. For each task id, collect all planned leaf names that carry that task's UUID suffix.
  //   2. Strip the `-<taskId>` suffix to get the `leafName` (matching TaskSubStep.leafName).
  //   3. Subtract already-executed leaf names (from task.subSteps) so only future steps show.
  //   4. Exclude dynamic generator/evaluator leaves — they repeat unknown rounds; showing them
  //      as pending would fabricate a fixed count of future rounds.
  //
  // Absent when `plannedLeaves` is not available (legacy sessions / non-implement flows).
  const pendingSubStepsByTaskId = useMemo<ReadonlyMap<string, readonly string[]> | undefined>(() => {
    if (bucketed === undefined || descriptor.plannedLeaves === undefined) return undefined;
    const plan = descriptor.plannedLeaves;
    const result = new Map<string, string[]>();

    for (const task of bucketed.tasks) {
      const taskId = task.id;
      const tail = `-${taskId}`;
      // Collect planned leaf names for this task (UUID-suffixed → strip suffix)
      const plannedForTask: string[] = [];
      for (const leaf of plan) {
        if (leaf.endsWith(tail) && UUID_SUFFIX_REGEX.test(leaf)) {
          plannedForTask.push(leaf.slice(0, -tail.length));
        }
      }
      if (plannedForTask.length === 0) continue;

      // Build set of already-executed leaf names for this task (deduped for gen-eval multi-run)
      const executed = new Set<string>(task.subSteps.map((s) => s.leafName));

      // Keep leaves that haven't executed yet and are not dynamic (generator/evaluator)
      const pending = plannedForTask.filter((leafName) => !executed.has(leafName) && !DYNAMIC_LEAF_NAMES.has(leafName));
      if (pending.length > 0) result.set(taskId, pending);
    }
    return result.size > 0 ? result : undefined;
  }, [bucketed, descriptor.plannedLeaves]);

  if (bucketed === undefined) return null;

  return (
    <TasksPanel
      bucketed={bucketed}
      running={isRunning}
      maxSignalsPerTask={maxSignalsPerTask}
      maxTasks={maxTasks}
      inputActive={inputActive}
      nowMs={now}
      {...(onFocusedCardChange !== undefined ? { onFocusedCardChange } : {})}
      {...(descriptor.taskNames !== undefined ? { nameById: descriptor.taskNames } : {})}
      {...(descriptor.taskRecovering !== undefined ? { recoveringByTaskId: descriptor.taskRecovering } : {})}
      {...(taskCriteriaById !== undefined ? { taskCriteriaById } : {})}
      {...(blockedReasonById !== undefined ? { blockedReasonById } : {})}
      {...(warningSummaryById !== undefined ? { warningSummaryById } : {})}
      {...(taskEvaluationById !== undefined ? { taskEvaluationById } : {})}
      {...(pendingSubStepsByTaskId !== undefined ? { pendingSubStepsByTaskId } : {})}
    />
  );
};
