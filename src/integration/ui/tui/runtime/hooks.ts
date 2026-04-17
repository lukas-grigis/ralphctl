/**
 * React hooks bridging the non-React event buses (`logEventBus`,
 * `SignalBusPort`) and the Ink component tree.
 *
 * All three hooks use `useSyncExternalStore`-style subscriptions to avoid
 * tearing during concurrent renders.
 */

import { useEffect, useState } from 'react';
import type { Config } from '@src/domain/models.ts';
import type { HarnessEvent, SignalBusPort } from '@src/business/ports/signal-bus.ts';
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

/**
 * Polled live config. `intervalMs` controls cadence (defaults to 2s — cheap
 * file read). Returns `null` until the first read completes.
 */
export function useLiveConfig(getConfig: () => Promise<Config>, intervalMs = 2000): Config | null {
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    let cancelled = false;

    const tick = async (): Promise<void> => {
      try {
        const c = await getConfig();
        if (!cancelled) setConfig(c);
      } catch {
        // Ignore transient read errors — UI keeps the previous value.
      }
    };

    void tick();
    const id = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [getConfig, intervalMs]);

  return config;
}
