/**
 * NotificationBus — single-slot publish/subscribe for sticky TUI notifications.
 *
 * Mirrors the SignalBus shape (subscribe with current, replace-on-new) but
 * holds at most one notification at a time. A new `show(notification)` call
 * replaces whatever was there, the previous notification's action shortcut
 * unbinds when its component unmounts.
 *
 * Two seams keep this testable:
 *   - `current()` returns the latest snapshot synchronously, which lets
 *     `useGlobalKeys` decide whether a keystroke belongs to the notification
 *     before propagating to the router.
 *   - `subscribe(listener)` invokes the listener with the current value on
 *     attach, matching `prompt-queue.subscribe` semantics so `useEffect` hooks
 *     don't need a separate "initial fetch" step.
 */
export type NotificationStatus = 'success' | 'error' | 'info' | 'warning';

export interface NotificationActionResult {
  readonly ok: boolean;
}

export interface NotificationActionOk {
  readonly ok: true;
}

export interface NotificationActionFail {
  readonly ok: false;
  readonly error: string;
}

export interface NotificationAction {
  readonly key: string;
  readonly label: string;
  run(): Promise<NotificationActionOk | NotificationActionFail>;
}

export interface Notification {
  readonly id: string;
  readonly message: string;
  readonly status: NotificationStatus;
  readonly action?: NotificationAction;
}

export type NotificationListener = (current: Notification | null) => void;
export type Unsubscribe = () => void;

export interface NotificationBus {
  show(notification: Notification): void;
  clear(id: string): void;
  current(): Notification | null;
  subscribe(listener: NotificationListener): Unsubscribe;
}

export class InMemoryNotificationBus implements NotificationBus {
  private active: Notification | null = null;
  private readonly listeners = new Set<NotificationListener>();

  show(notification: Notification): void {
    this.active = notification;
    this.notify();
  }

  clear(id: string): void {
    if (this.active?.id !== id) return;
    this.active = null;
    this.notify();
  }

  current(): Notification | null {
    return this.active;
  }

  subscribe(listener: NotificationListener): Unsubscribe {
    this.listeners.add(listener);
    try {
      listener(this.active);
    } catch {
      // Initial-attach delivery must not propagate listener errors — the
      // contract says one bad subscriber never breaks the bus for others.
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l(this.active);
      } catch {
        // Listener errors must never stall delivery to others.
      }
    }
  }
}

export const notificationBus: NotificationBus = new InMemoryNotificationBus();
