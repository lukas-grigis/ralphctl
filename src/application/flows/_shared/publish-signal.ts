import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';

/**
 * Fan-out seam every AI-spawning leaf calls once per validated signal, under the audit-[09]
 * contract. This is the ONE harness-signal channel — collapses the legacy `HarnessSignalSink` +
 * typed `ai-signal` EventBus dual-emit into a single publish. Every validated signal kind flows
 * through here, not just the text-bearing subset the old sink mirror filtered to.
 *
 * A plain function type, not a port interface — leaves depend on this directly rather than on a
 * `Sink`-shaped seam, because the only operation is "publish one signal".
 */
export type PublishSignal = (signal: HarnessSignal) => void;

/**
 * Build a `PublishSignal` bound to one flow's `source` (and, for the implement flow's parallel
 * worktree branches, one task's `taskId`).
 *
 *  - `source` is the leaf/flow's own short name (`'generator'`, `'evaluator'`, `'review-round'`,
 *    `'detect-scripts'`, `'detect-skills'`, `'implement'`, …) so a multi-leaf flow's signals stay
 *    attributable on the bus.
 *  - `taskId` is stamped only by the implement flow's per-branch publisher (see
 *    `wave-branch.ts`'s `perBranchSignalPublisher`) — every other caller omits it, and the TUI's
 *    task-bucketing falls back to its timestamp-window heuristic when it's absent.
 */
export const createPublishSignal =
  (eventBus: EventBus, source: string, taskId?: string): PublishSignal =>
  (signal) => {
    eventBus.publish({ type: 'ai-signal', signal, source, ...(taskId !== undefined ? { taskId } : {}) });
  };
