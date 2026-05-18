/**
 * Wraps a {@link LogLevelGate} in React state so the Settings view's `logging.level` write path
 * can update the live floor used by the TUI's `EventBus -> logBus` forwarder. The forwarder
 * keeps a stable reference to the gate (initialised in `launch.ts`) and reads the current floor
 * on every event; this context exposes a `setLevel` to mutate that gate plus a React-tracked
 * mirror so views can render the current value without subscribing to the gate directly.
 */

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { LogLevel } from '@src/domain/value/log-level.ts';
import type { LogLevelGate } from '@src/business/observability/log-level-filter.ts';

export interface LogLevelContextValue {
  readonly level: LogLevel;
  readonly setLevel: (level: LogLevel) => void;
}

const LogLevelContext = createContext<LogLevelContextValue | undefined>(undefined);

export const useLogLevel = (): LogLevelContextValue => {
  const ctx = useContext(LogLevelContext);
  if (!ctx) throw new Error('useLogLevel: must be used inside <LogLevelProvider>');
  return ctx;
};

export const LogLevelProvider = ({
  gate,
  children,
}: {
  readonly gate: LogLevelGate;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const [level, setLevelState] = useState<LogLevel>(gate.get());
  const setLevel = useCallback(
    (next: LogLevel): void => {
      gate.set(next);
      setLevelState(next);
    },
    [gate]
  );
  const value = useMemo<LogLevelContextValue>(() => ({ level, setLevel }), [level, setLevel]);
  return <LogLevelContext.Provider value={value}>{children}</LogLevelContext.Provider>;
};
