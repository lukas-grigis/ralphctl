import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { TaskBlockedEvent } from '@src/business/observability/events.ts';
import type { BlockedTask } from '@src/domain/entity/task.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import { sanitizeDisplayText } from '@src/domain/value/display-text.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Display budget for the event's two text fields. Every subscriber renders them on one short line
 * (the TUI attention banner, the OS notification body), so the clamp belongs at the producer
 * rather than being re-derived by each of them.
 */
const EVENT_TEXT_MAX_CHARS = 200;

/** The first line of `text` — a later line of `blockedReason` can carry a quarantine-stash pointer. */
const firstLine = (text: string): string => text.split('\n', 1)[0] ?? text;

/**
 * Publish {@link TaskBlockedEvent} for a task that just transitioned into `blocked`, so
 * `notification-subscriber` raises the operator-attention banner / OS notification.
 *
 * Call it EXACTLY ONCE per block, at the site that decides the block, never at a site that merely
 * rewrites an already-blocked task (the quarantine pointer write, the epilogue save) — a second
 * call is a second notification.
 *
 * `taskName` is planner-authored and `blockedReason` generator- or harness-authored; both land on
 * an operator's terminal and in an OS notification, so {@link sanitizeDisplayText} runs here and
 * no subscriber has to remember it.
 */
export const publishTaskBlocked = (eventBus: EventBus, task: BlockedTask, at: IsoTimestamp): void => {
  const event: TaskBlockedEvent = {
    type: 'task-blocked',
    taskId: String(task.id),
    taskName: sanitizeDisplayText(task.name, EVENT_TEXT_MAX_CHARS),
    blockKind: task.blockKind,
    reason: sanitizeDisplayText(firstLine(task.blockedReason), EVENT_TEXT_MAX_CHARS),
    at,
  };
  eventBus.publish(event);
};

/**
 * Wrap an {@link UpdateTask} so every SUCCESSFUL write of a `blocked` task also publishes
 * {@link TaskBlockedEvent} — publish only once the block is durable, same as the settle path.
 *
 * For a use case that persists a block its caller never gets to see: `startAttemptUseCase`'s
 * resume path writes the budget-exhausted block and then returns an error, so the leaf around it
 * has no blocked task to publish. Wrap ONLY a use case whose blocked writes are all transitions
 * INTO `blocked` — one that rewrites an already-blocked task (`recordQuarantineUseCase` appending
 * its pointer) would announce the same block twice.
 */
export const publishingBlockedWrites = (
  taskRepo: UpdateTask,
  eventBus: EventBus,
  clock: () => IsoTimestamp
): UpdateTask => ({
  async update(sprintId, task) {
    const persisted = await taskRepo.update(sprintId, task);
    if (persisted.ok && task.status === 'blocked') publishTaskBlocked(eventBus, task, clock());
    return persisted;
  },
});
