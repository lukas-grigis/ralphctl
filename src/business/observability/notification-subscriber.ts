/**
 * EventBus → NotificationDispatcher bridge. Subscribes to the application's event stream and
 * fires OS notifications for events the operator likely walked away from the terminal for.
 *
 * The bridge stays at the bus boundary on purpose: producers (chain runner, leaves, adapters)
 * publish their existing events; the bridge filters and routes. No producer needs to know that
 * a notification dispatcher exists.
 *
 * Triggers (kept conservative — anything we surface here costs the operator a NotificationCenter
 * ding, so the bar is "you should care, not just be informed"):
 *
 *  - `chain-step-failed` for `'setup-script-runner'` → `failure` ("setup failed").
 *  - `chain-aborted`                                 → `failure` ("ralphctl aborted").
 *  - `log` event with `meta.delayMs ≥ 60_000`        → `paused`  ("Waiting for rate limit").
 *      (The headless AI adapters publish a log info with `{ delayMs, nextAttempt, maxAttempts }`
 *      before sleeping; a delay ≥ 60s is the operator-visible "ralphctl is asleep" threshold.)
 *  - `log` warn message containing `'baseline already red'` → `attention` ("Pre-verify red").
 *      (The pre-task-verify leaf publishes this when the working tree is broken before the AI
 *      gets to touch it.)
 *
 * Notes for future maintainers:
 *
 *  - `disabled()` is a getter, not a captured boolean, so the Settings view can flip the flag
 *    at runtime without re-wiring the subscriber. When the flag is off, the bridge stays
 *    subscribed but every event is a no-op — keeps the wiring simple.
 *  - Dispatch is fire-and-forget (`void dispatcher.notify(...)`). The dispatcher contract
 *    guarantees no throws; we still don't `await` because the bus subscribe handler is
 *    synchronous and we don't want to stall delivery to other subscribers.
 *  - String-match heuristics (`'baseline already red'`, `meta.delayMs`) are an explicit
 *    compromise to keep this subscriber decoupled from leaf-specific event types. If a
 *    producer renames its log message, the corresponding notification stops firing — covered
 *    by a unit test that pins the substring.
 */

import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AppEvent, LogEvent } from '@src/business/observability/events.ts';
import type { NotificationDispatcher } from '@src/business/observability/notification-dispatcher.ts';

/** Rate-limit pauses shorter than this don't disturb the operator. */
const PAUSE_NOTIFY_THRESHOLD_MS = 60_000;

/** Substring published by `pre-task-verify.ts` when the baseline is broken at task start. */
const BASELINE_RED_MARKER = 'baseline already red';

/** Element name of the setup-script leaf. Substring-matched so future suffixes (`-1`, etc.) work. */
const SETUP_SCRIPT_LEAF_PREFIX = 'setup-script-runner';

export interface NotificationSubscriberDeps {
  readonly eventBus: EventBus;
  readonly dispatcher: NotificationDispatcher;
  /**
   * Read-on-call disable gate. The settings repo's notifications-enabled flag is read via this
   * thunk so a Settings view toggle takes effect immediately — no need to re-wire the bridge.
   */
  readonly disabled: () => boolean;
}

/**
 * Subscribe to the bus and return an unsubscribe function. Call once at composition-root time.
 */
export const startNotificationSubscriber = (deps: NotificationSubscriberDeps): (() => void) => {
  const handle = (event: AppEvent): void => {
    if (deps.disabled()) return;
    const decision = classify(event);
    if (decision === undefined) return;
    // Fire-and-forget: the dispatcher contract guarantees no throws, but a misbehaving impl
    // would otherwise surface as an unhandled-rejection that crashes the harness on
    // `process.on('unhandledRejection')`. `.catch(noop)` keeps the bus subscriber synchronous
    // (Promises are scheduled to a microtask, never awaited here).
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
 * Pure decision function over an AppEvent. Exported so unit tests can pin the trigger taxonomy
 * without driving the bus end-to-end.
 */
export const classifyEventForNotification = (event: AppEvent): NotificationDecision | undefined => classify(event);

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
 * Trim `pre-task-verify <path>: baseline already red (...) — task will start on broken baseline`
 * down to the path-shaped prefix. Best-effort; if the producer message changes the body falls
 * back to the full message, which is still useful to the operator.
 */
const extractTaskHint = (message: string): string => {
  const colon = message.indexOf(':');
  if (colon <= 0) return message;
  // Strip the leaf name prefix so the body reads as "<cwd>".
  const prefix = message.slice(0, colon);
  const space = prefix.indexOf(' ');
  if (space < 0) return prefix;
  return prefix.slice(space + 1);
};
