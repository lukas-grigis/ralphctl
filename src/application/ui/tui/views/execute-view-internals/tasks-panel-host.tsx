/** Adapter that wires the live bucketed-task derivation into the shared `TasksPanel`. */

import React, { useCallback, useMemo } from 'react';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { overlayEntityBlockedStatus, UUID_SUFFIX_REGEX } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { TaskEvaluation } from '@src/application/ui/tui/components/tasks-panel-internals/evaluation-row.tsx';
import type { BlockedTriage } from '@src/application/ui/tui/components/tasks-projection.ts';
import { useUnblockTask } from '@src/application/ui/tui/runtime/use-unblock-task.ts';
import type { AttemptWarning } from '@src/domain/entity/attempt.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { latestRecordedEvaluation } from '@src/business/task/evaluation-artifact.ts';

/** Stable empty set — never recreated per render while a run is live (see {@link blockedTaskIds}). */
const NO_BLOCKED_TASK_IDS: ReadonlySet<string> = new Set();

/** Dynamic gen-eval leaf names that repeat an unknown number of rounds. */
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

/** `taskId → verificationCriteria bullets`, one line per criterion. */
const criteriaBulletsByTaskId = (taskState: readonly Task[]): ReadonlyMap<string, readonly string[]> => {
  const byId = new Map<string, readonly string[]>();
  for (const t of taskState) {
    const bullets = t.verificationCriteria.map((c) =>
      c.check === 'auto' && c.command !== undefined
        ? `[${c.id}] auto \`${c.command}\` — ${c.assertion}`
        : `[${c.id}] manual — ${c.assertion}`
    );
    byId.set(String(t.id), bullets);
  }
  return byId;
};

/** `taskId → blockedReason` for blocked tasks, so the panel can render WHY a card blocked. */
const blockedReasonsByTaskId = (taskState: readonly Task[]): ReadonlyMap<string, string> | undefined => {
  const byId = new Map<string, string>();
  for (const t of taskState) {
    if (t.status === 'blocked') byId.set(String(t.id), t.blockedReason);
  }
  return byId.size > 0 ? byId : undefined;
};

/**
 * `taskId → structured block triage` for a blocked task whose self-block signal supplied the generator's own question
 * / what-would-unblock-it fields (see `BlockedTask.question` / `.whatUnblocksMe` on the domain entity).
 */
const blockedTriageByTaskId = (taskState: readonly Task[]): ReadonlyMap<string, BlockedTriage> | undefined => {
  const byId = new Map<string, BlockedTriage>();
  for (const t of taskState) {
    if (t.status !== 'blocked') continue;
    if (t.question === undefined && t.whatUnblocksMe === undefined) continue;
    byId.set(String(t.id), {
      ...(t.question !== undefined ? { question: t.question } : {}),
      ...(t.whatUnblocksMe !== undefined ? { whatUnblocksMe: t.whatUnblocksMe } : {}),
    });
  }
  return byId.size > 0 ? byId : undefined;
};

/** `taskId → one-line summary` for a done task whose FINAL attempt carries a warning. */
const warningSummariesByTaskId = (taskState: readonly Task[]): ReadonlyMap<string, string> | undefined => {
  const byId = new Map<string, string>();
  for (const t of taskState) {
    if (t.status !== 'done') continue;
    const warning = t.attempts[t.attempts.length - 1]?.warning;
    if (warning !== undefined) byId.set(String(t.id), warningSummaryFor(warning));
  }
  return byId.size > 0 ? byId : undefined;
};

/**
 * `taskId → AUTHORITATIVE evaluation verdict`, sourced from the task entity's attempts (keyed by task id, so there is
 * no cross-task / stale-window leak).
 */
const evaluationsByTaskId = (taskState: readonly Task[]): ReadonlyMap<string, TaskEvaluation> | undefined => {
  const byId = new Map<string, TaskEvaluation>();
  for (const t of taskState) {
    const latest = latestRecordedEvaluation(t);
    if (latest === undefined) continue;
    byId.set(String(t.id), {
      status: latest.status,
      attemptN: latest.attemptN,
      ...(latest.finishedAt !== undefined ? { finishedAt: latest.finishedAt } : {}),
      // Absent for a legacy row that recorded a verdict but no artifact — the `v` chord still
      // opens, and the overlay degrades to the same one-line verdict the card shows.
      ...(latest.file.length > 0 ? { file: latest.file } : {}),
    });
  }
  return byId.size > 0 ? byId : undefined;
};

/** `taskId → pending (not-yet-executed) sub-step leaf names`, derived from the planned leaves. */
const pendingLeavesByTaskId = (
  tasks: readonly TaskBucket[],
  plannedLeaves: readonly string[]
): ReadonlyMap<string, readonly string[]> | undefined => {
  const byId = new Map<string, string[]>();
  for (const task of tasks) {
    const tail = `-${task.id}`;
    const plannedForTask: string[] = [];
    for (const leaf of plannedLeaves) {
      if (leaf.endsWith(tail) && UUID_SUFFIX_REGEX.test(leaf)) plannedForTask.push(leaf.slice(0, -tail.length));
    }
    if (plannedForTask.length === 0) continue;
    // Deduped for the gen-eval multi-run case, where one leaf name appears in many sub-steps.
    const executed = new Set<string>(task.subSteps.map((s) => s.leafName));
    const pending = plannedForTask.filter((leafName) => !executed.has(leafName) && !DYNAMIC_LEAF_NAMES.has(leafName));
    if (pending.length > 0) byId.set(task.id, pending);
  }
  return byId.size > 0 ? byId : undefined;
};

interface UseUnblockAffordanceInput {
  readonly isRunning: boolean;
  readonly blockedReasonById: ReadonlyMap<string, string> | undefined;
  readonly taskState: readonly Task[] | undefined;
  readonly sprintId: SprintId | undefined;
}

interface UnblockAffordance {
  readonly blockedTaskIds: ReadonlySet<string>;
  readonly onUnblock: (taskId: string) => void;
}

/**
 * The `u` chord's gate + handler, split out of {@link TasksPanelHostImpl} purely to keep that component under the
 * file's per-function line budget — this is the SAME logic, just named.
 */
const useUnblockAffordance = ({
  isRunning,
  blockedReasonById,
  taskState,
  sprintId,
}: UseUnblockAffordanceInput): UnblockAffordance => {
  const blockedTaskIds = useMemo<ReadonlySet<string>>(
    () => (isRunning ? NO_BLOCKED_TASK_IDS : new Set(blockedReasonById?.keys() ?? [])),
    [isRunning, blockedReasonById]
  );
  const unblockTask = useUnblockTask();
  const onUnblock = useCallback(
    (taskId: string): void => {
      // Defense in depth — see the TOCTOU note above.
      if (isRunning || sprintId === undefined) return;
      const target = taskState?.find((t) => String(t.id) === taskId);
      if (target === undefined) return;
      // Fire-and-forget: the use case logs its own outcome through the injected `Logger`.
      void unblockTask(target, sprintId);
    },
    [isRunning, sprintId, taskState, unblockTask]
  );
  return { blockedTaskIds, onUnblock };
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
  /** Optional callback — fired (deduped) when the focused card's expansion state changes. See `TasksPanel`. */
  readonly onExpandedCardChange?: (expanded: boolean) => void;
  /** Optional `v` handler — opens the evaluation overlay for a card that has a recorded verdict. */
  readonly onOpenEvaluation?: (taskId: string) => void;
}

const TasksPanelHostImpl = ({
  bucketed,
  descriptor,
  isRunning,
  maxSignalsPerTask,
  maxTasks,
  inputActive,
  now,
  taskState,
  onFocusedCardChange,
  onExpandedCardChange,
  onOpenEvaluation,
}: TasksPanelHostProps): React.JSX.Element | null => {
  const taskCriteriaById = useMemo(
    () => (taskState !== undefined ? criteriaBulletsByTaskId(taskState) : undefined),
    [taskState]
  );
  const blockedReasonById = useMemo(
    () => (taskState !== undefined ? blockedReasonsByTaskId(taskState) : undefined),
    [taskState]
  );
  const blockedTriageById = useMemo(
    () => (taskState !== undefined ? blockedTriageByTaskId(taskState) : undefined),
    [taskState]
  );
  // The run's own pinned sprint — same field `execute-view.tsx` reads to scope this session independently of the
  // mutable global selection.
  const sprintId = descriptor.pinnedSprintId;
  const { blockedTaskIds, onUnblock } = useUnblockAffordance({ isRunning, blockedReasonById, taskState, sprintId });
  const warningSummaryById = useMemo(
    () => (taskState !== undefined ? warningSummariesByTaskId(taskState) : undefined),
    [taskState]
  );
  const taskEvaluationById = useMemo(
    () => (taskState !== undefined ? evaluationsByTaskId(taskState) : undefined),
    [taskState]
  );
  // Correct the trace-only blind spot BEFORE anything downstream reads a task's status.
  const correctedBucketed = useMemo(
    () => (bucketed !== undefined ? overlayEntityBlockedStatus(bucketed, taskState, isRunning) : undefined),
    [bucketed, taskState, isRunning]
  );
  // Absent when `plannedLeaves` is not available (legacy sessions / non-implement flows).
  const plannedLeaves = descriptor.plannedLeaves;
  const pendingSubStepsByTaskId = useMemo(
    () =>
      correctedBucketed !== undefined && plannedLeaves !== undefined
        ? pendingLeavesByTaskId(correctedBucketed.tasks, plannedLeaves)
        : undefined,
    [correctedBucketed, plannedLeaves]
  );

  if (correctedBucketed === undefined) return null;

  return (
    <TasksPanel
      bucketed={correctedBucketed}
      running={isRunning}
      maxSignalsPerTask={maxSignalsPerTask}
      maxTasks={maxTasks}
      inputActive={inputActive}
      nowMs={now}
      blockedTaskIds={blockedTaskIds}
      onUnblock={onUnblock}
      {...(onFocusedCardChange !== undefined ? { onFocusedCardChange } : {})}
      {...(onExpandedCardChange !== undefined ? { onExpandedCardChange } : {})}
      {...(onOpenEvaluation !== undefined ? { onOpenEvaluation } : {})}
      {...(descriptor.taskNames !== undefined ? { nameById: descriptor.taskNames } : {})}
      {...(descriptor.taskRecovering !== undefined ? { recoveringByTaskId: descriptor.taskRecovering } : {})}
      {...(taskCriteriaById !== undefined ? { taskCriteriaById } : {})}
      {...(blockedReasonById !== undefined ? { blockedReasonById } : {})}
      {...(blockedTriageById !== undefined ? { blockedTriageById } : {})}
      {...(warningSummaryById !== undefined ? { warningSummaryById } : {})}
      {...(taskEvaluationById !== undefined ? { taskEvaluationById } : {})}
      {...(pendingSubStepsByTaskId !== undefined ? { pendingSubStepsByTaskId } : {})}
    />
  );
};

// Memoized for hygiene / protection against unrelated-prop churn elsewhere in the tree (e.g. a sibling resize or
// cancel-scope toggle).
export const TasksPanelHost = React.memo(TasksPanelHostImpl);
