/**
 * Provides the TUI's bus sinks (harness + log) via React context. Views subscribe through the
 * hooks in `use-sink-stream.ts`; the production composition root forwards everything emitted by
 * `AppDeps.sinks` into these buses.
 */

import React, { createContext, useContext } from 'react';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { LogEvent } from '@src/business/observability/events.ts';
import type { BusSink } from '@src/application/ui/tui/runtime/sinks-bus.ts';

export interface TuiBuses {
  readonly harness: BusSink<HarnessSignal>;
  readonly log: BusSink<LogEvent>;
}

const BusesContext = createContext<TuiBuses | undefined>(undefined);

export interface BusesProviderProps {
  readonly value: TuiBuses;
  readonly children: React.ReactNode;
}

export const BusesProvider = ({ value, children }: BusesProviderProps): React.JSX.Element => (
  <BusesContext.Provider value={value}>{children}</BusesContext.Provider>
);

export const useBuses = (): TuiBuses => {
  const ctx = useContext(BusesContext);
  if (!ctx) throw new Error('useBuses: must be used inside <BusesProvider>');
  return ctx;
};
