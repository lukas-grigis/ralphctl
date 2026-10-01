/** Maps a live session descriptor onto the shape `buildAgenda` reads, incl. per-task progress. */

import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import {
  bucketTaskSignals,
  isInFlightBucket,
  resolveAttemptCoords,
} from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { AgendaSession } from '@src/application/ui/tui/views/home-internals/agenda.ts';

const progressOf = (d: SessionDescriptor): AgendaSession['progress'] => {
  if (d.status !== 'running' || d.taskNames === undefined || d.taskNames.size === 0) return undefined;
  const ids = [...d.taskNames.keys()];
  const { tasks } = bucketTaskSignals(d.trace, [], [], {
    knownTaskIds: ids,
    ...(d.maxTurns !== undefined ? { maxTurns: d.maxTurns } : {}),
    ...(d.maxAttempts !== undefined ? { maxAttempts: d.maxAttempts } : {}),
    ...(d.terminalSubstepName !== undefined ? { terminalSubstepName: d.terminalSubstepName } : {}),
  });
  const running = tasks.find(isInFlightBucket);
  if (running === undefined) return undefined;
  const coords = resolveAttemptCoords(running);
  return {
    taskIndex: ids.indexOf(running.id) + 1,
    taskCount: ids.length,
    taskName: d.taskNames.get(running.id) ?? running.id,
    ...(coords !== undefined && running.genEvalMaxAttempts !== undefined
      ? { attempt: coords.attemptN, maxAttempts: running.genEvalMaxAttempts }
      : {}),
  };
};

export const toAgendaSession = (d: SessionDescriptor): AgendaSession => {
  const progress = progressOf(d);
  return {
    id: d.id,
    flowId: d.flowId,
    status: d.status,
    startedAt: d.startedAt,
    ...(d.finishedAt !== undefined ? { finishedAt: d.finishedAt } : {}),
    ...(d.pinnedSprintId !== undefined ? { pinnedSprintId: d.pinnedSprintId } : {}),
    ...(progress !== undefined ? { progress } : {}),
  };
};
