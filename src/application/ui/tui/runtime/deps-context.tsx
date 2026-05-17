/**
 * `AppDeps` accessed via React context — every view that needs a repository or the AI provider
 * pulls it from here, never from a global. The bootstrap layer wires the deps once and renders
 * `<DepsProvider value={deps}>` around the router.
 */

import React, { createContext, useContext } from 'react';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';

const DepsContext = createContext<AppDeps | undefined>(undefined);

export interface DepsProviderProps {
  readonly value: AppDeps;
  readonly children: React.ReactNode;
}

export const DepsProvider = ({ value, children }: DepsProviderProps): React.JSX.Element => (
  <DepsContext.Provider value={value}>{children}</DepsContext.Provider>
);

export const useDeps = (): AppDeps => {
  const ctx = useContext(DepsContext);
  if (!ctx) throw new Error('useDeps: must be used inside <DepsProvider>');
  return ctx;
};
