/**
 * Notification dispatcher port — surfaces operator-attention events to the host OS so the user
 * can walk away from the terminal without missing an event that needs them.
 *
 * Levels are advisory taxonomy, not severity ordering:
 *
 *   - `'attention'` — the harness wants the operator's eyes (broken baseline, sprint wedged).
 *   - `'paused'`    — the harness is waiting on something external (rate-limit backoff ≥ 60s).
 *   - `'failure'`   — a non-recoverable step blew up (setup script red, chain aborted externally).
 *
 * Implementations MUST be best-effort: the dispatcher's promise resolves regardless of whether
 * the host OS surfaced the notification. A missing `osascript` / `notify-send` / PowerShell host
 * is not an error — the terminal bell character (`\x07`) is the floor every platform agrees on.
 *
 * Errors are absorbed: a thrown shell-out, a busy notification daemon, an undelivered notification
 * — none of these block the harness or surface to the caller. The dispatcher logs at debug level
 * if anything went sideways; everything else stays silent.
 *
 * One bus per `wire()` call wires one dispatcher; the notification subscriber in
 * `notification-subscriber.ts` filters relevant `AppEvent`s and calls `notify(...)`. Use cases
 * never call the dispatcher directly — they publish events on the bus and the subscriber decides
 * what's worth surfacing.
 */
export interface NotificationDispatcher {
  /**
   * Emit a single notification. The implementation chooses how to surface it (terminal bell,
   * NotificationCenter, libnotify, …). Never throws — every failure path is absorbed.
   *
   * `body` is optional because some notifications (a bell alone) are sufficient on their own.
   */
  notify(level: 'attention' | 'paused' | 'failure', title: string, body?: string): Promise<void>;
}
