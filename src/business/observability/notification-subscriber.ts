/** EventBus → NotificationDispatcher bridge. */

import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AppEvent, LogEvent } from '@src/business/observability/events.ts';
import type { NotificationDispatcher } from '@src/business/observability/notification-dispatcher.ts';

/** Rate-limit pauses shorter than this don't disturb the operator. */
const PAUSE_NOTIFY_THRESHOLD_MS = 60_000;

/** Runs shorter than this finish while the operator is still watching — no completion ping. */
const COMPLETION_NOTIFY_MIN_MS = 2 * 60_000;

/** Substring published by `pre-task-verify.ts` when the baseline is broken at task start. */
const BASELINE_RED_MARKER = 'baseline already red';

/** Element name of the setup-script leaf. Substring-matched so future suffixes (`-1`, etc.) work. */
const SETUP_SCRIPT_LEAF_PREFIX = 'setup-script-runner';

export interface NotificationSubscriberDeps {
  readonly eventBus: EventBus;
  readonly dispatcher: NotificationDispatcher;
  /** Read-on-call disable gate. */
  readonly disabled: () => boolean;
}

/** Subscribe to the bus and return an unsubscribe function. Call once at composition-root time. */
export const startNotificationSubscriber = (deps: NotificationSubscriberDeps): (() => void) => {
  // chainId → { first start, nesting depth }. A re-started chain id nests, so only the outermost completion may ping.
  const running = new Map<string, { readonly startedAt: number; depth: number }>();

  const completionDecision = (event: AppEvent): NotificationDecision | undefined => {
    if (event.type === 'chain-started') {
      // A nested runner (parallel task branch, prologue / epilogue) is part of its parent's run.
      if (event.parentChainId !== undefined) return undefined;
      const open = running.get(event.chainId);
      if (open) open.depth += 1;
      else running.set(event.chainId, { startedAt: Date.parse(event.at), depth: 1 });
      return undefined;
    }
    if (event.type !== 'chain-completed' && event.type !== 'chain-failed' && event.type !== 'chain-aborted') {
      return undefined;
    }
    const open = running.get(event.chainId);
    if (!open) return undefined;
    open.depth -= 1;
    if (open.depth > 0) return undefined;
    running.delete(event.chainId);
    if (event.type !== 'chain-completed') return undefined;
    const elapsedMs = Date.parse(event.at) - open.startedAt;
    if (!(elapsedMs >= COMPLETION_NOTIFY_MIN_MS)) return undefined;
    return { level: 'attention', title: 'ralphctl: run finished', body: `Done after ${formatMinutes(elapsedMs)}` };
  };

  const handle = (event: AppEvent): void => {
    const completion = completionDecision(event);
    if (deps.disabled()) return;
    const decision = completion ?? classify(event);
    if (decision === undefined) return;
    // Fire-and-forget: the dispatcher contract guarantees no throws, but a misbehaving impl would otherwise surface
    // as an unhandled-rejection that crashes the harness on `process.on('unhandledRejection')`.
    deps.dispatcher.notify(decision.level, decision.title, decision.body).catch(() => undefined);
  };
  return deps.eventBus.subscribe(handle);
};

interface NotificationDecision {
  readonly level: 'attention' | 'paused' | 'failure';
  readonly title: string;
  readonly body?: string;
}

/**
 * Pure decision function over an AppEvent. Exported so unit tests can pin the trigger taxonomy without driving the
 * bus end-to-end.
 */
export const classifyEventForNotification = (event: AppEvent): NotificationDecision | undefined => classify(event);

const formatMinutes = (ms: number): string => `${String(Math.floor(ms / 60_000))} min`;

const classify = (event: AppEvent): NotificationDecision | undefined => {
  switch (event.type) {
    case 'chain-step-failed':
      if (event.elementName.startsWith(SETUP_SCRIPT_LEAF_PREFIX)) {
        return {
          level: 'failure',
          title: 'ralphctl: setup failed',
          body: event.error.message,
        };
      }
      return undefined;
    case 'chain-aborted':
      return {
        level: 'failure',
        title: 'ralphctl aborted',
        ...(event.reason !== undefined ? { body: event.reason } : {}),
      };
    case 'awaiting-input':
      return { level: 'attention', title: 'Waiting on you', body: event.message };
    case 'task-blocked':
      return {
        level: 'attention',
        title: 'Task blocked',
        body: `${event.taskName}: ${event.reason}`,
      };
    case 'log':
      return classifyLog(event);
    default:
      return undefined;
  }
};

const classifyLog = (event: LogEvent): NotificationDecision | undefined => {
  // Rate-limit pause: the headless adapters publish `{ delayMs, nextAttempt, maxAttempts }`
  // before sleeping. Threshold gate keeps short retries (sub-minute backoffs) silent.
  const delayMs = readNumber(event.meta, 'delayMs');
  if (delayMs !== undefined && delayMs >= PAUSE_NOTIFY_THRESHOLD_MS) {
    return {
      level: 'paused',
      title: 'ralphctl paused',
      body: 'Waiting for rate limit',
    };
  }
  // Baseline-broken at task start: pre-task-verify.ts publishes a `warn` log when the baseline
  // is red. Substring-match the canonical message so renames here flag in tests.
  if (event.level === 'warn' && event.message.includes(BASELINE_RED_MARKER)) {
    return {
      level: 'attention',
      title: 'Pre-verify red',
      body: extractTaskHint(event.message),
    };
  }
  return undefined;
};

const readNumber = (meta: LogEvent['meta'], key: string): number | undefined => {
  if (meta === undefined) return undefined;
  const raw = meta[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
};

/**
 * Trim `pre-task-verify <path>: baseline already red (...) — task will start on broken baseline` down to the
 * path-shaped prefix.
 */
const extractTaskHint = (message: string): string => {
  // Anchor on the marker, not the first colon — a Windows drive (`C:`) or a POSIX path may contain one.
  const at = message.indexOf(`: ${BASELINE_RED_MARKER}`);
  if (at <= 0) return message;
  // Strip the leaf name prefix so the body reads as "<cwd>".
  const prefix = message.slice(0, at);
  const space = prefix.indexOf(' ');
  return space < 0 ? prefix : prefix.slice(space + 1);
};
