/**
 * React hooks bridging the non-React event buses (`logEventBus`,
 * `SignalBusPort`) and the Ink component tree.
 *
 * All three hooks use `useSyncExternalStore`-style subscriptions to avoid
 * tearing during concurrent renders.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HarnessEvent, SignalBusPort } from '@src/business/ports/signal-bus.ts';
import { type DashboardData, loadDashboardData } from '@src/integration/ui/tui/views/dashboard-data.ts';
import { getSharedDeps } from '@src/integration/bootstrap.ts';
import { logEventBus, type LogEvent } from './event-bus.ts';

/**
 * Subscribe to log events. Returns a rolling buffer of the most recent events
 * up to `limit` (default 200). The buffer is a new array on every update so
 * React re-renders.
 */
export function useLoggerEvents(limit = 200): readonly LogEvent[] {
  const [buffer, setBuffer] = useState<LogEvent[]>([]);

  useEffect(() => {
    const unsubscribe = logEventBus.subscribe((batch) => {
      setBuffer((prev) => {
        const next = prev.concat(batch);
        if (next.length > limit) next.splice(0, next.length - limit);
        return next;
      });
    });
    return unsubscribe;
  }, [limit]);

  return buffer;
}

/**
 * Subscribe to harness signals/events. Returns a rolling buffer up to `limit`.
 */
export function useSignalEvents(bus: SignalBusPort, limit = 200): readonly HarnessEvent[] {
  const [buffer, setBuffer] = useState<HarnessEvent[]>([]);

  useEffect(() => {
    const unsubscribe = bus.subscribe((batch) => {
      setBuffer((prev) => {
        const next = prev.concat(batch);
        if (next.length > limit) next.splice(0, next.length - limit);
        return next;
      });
    });
    return unsubscribe;
  }, [bus, limit]);

  return buffer;
}

interface UseDashboardData {
  data: DashboardData | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Minimum gap between auto-refreshes triggered by the signal bus. Keeps the
 * filesystem loader from re-running on every micro-batched flush while still
 * feeling live during a running sprint. */
const DASHBOARD_REFRESH_THROTTLE_MS = 500;

/**
 * Loads dashboard data on mount and exposes a manual `refresh()` trigger.
 *
 * Also subscribes to `SharedDeps.signalBus` so task lifecycle events
 * (task-started / task-finished / per-task signals) trigger a throttled
 * reload — the dashboard becomes a live surface during `sprint start`
 * without needing its own filesystem watcher.
 *
 * Both Home (compact one-line summary) and Dashboard (full destination view)
 * call this — the loader does its own filesystem reads via `loadDashboardData`,
 * so concurrent callers don't share state, but they get the same shape and the
 * same null-when-missing semantics.
 */
export function useDashboardData(): UseDashboardData {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [counter, setCounter] = useState(0);
  const lastRefreshAt = useRef(0);
  const pendingRefresh = useRef<NodeJS.Timeout | null>(null);

  const refresh = useCallback((): void => {
    setCounter((n) => n + 1);
  }, []);

  const scheduleRefresh = useCallback((): void => {
    const elapsed = Date.now() - lastRefreshAt.current;
    if (elapsed >= DASHBOARD_REFRESH_THROTTLE_MS) {
      lastRefreshAt.current = Date.now();
      setCounter((n) => n + 1);
      return;
    }
    if (pendingRefresh.current) return;
    pendingRefresh.current = setTimeout(() => {
      pendingRefresh.current = null;
      lastRefreshAt.current = Date.now();
      setCounter((n) => n + 1);
    }, DASHBOARD_REFRESH_THROTTLE_MS - elapsed);
  }, []);

  useEffect(() => {
    const cancel = { current: false };
    setLoading(true);
    void (async () => {
      try {
        const next = await loadDashboardData();
        if (cancel.current) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (!cancel.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancel.current) setLoading(false);
      }
    })();
    return () => {
      cancel.current = true;
    };
  }, [counter]);

  useEffect(() => {
    // Guard against test environments where SharedDeps is never wired up —
    // the dashboard should still render statically from the mocked loader.
    let bus: SignalBusPort;
    try {
      bus = getSharedDeps().signalBus;
    } catch {
      return;
    }
    const unsubscribe = bus.subscribe(() => {
      scheduleRefresh();
    });
    return () => {
      unsubscribe();
      if (pendingRefresh.current) {
        clearTimeout(pendingRefresh.current);
        pendingRefresh.current = null;
      }
    };
  }, [scheduleRefresh]);

  return { data, loading, error, refresh };
}
