/**
 * Provides the `PromptQueue` via context so views (mostly the prompt host) can access it
 * without prop-drilling.
 */

import React, { createContext, useContext } from 'react';
import type { PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';

const PromptQueueContext = createContext<PromptQueue | undefined>(undefined);

export interface PromptQueueProviderProps {
  readonly value: PromptQueue;
  readonly children: React.ReactNode;
}

export const PromptQueueProvider = ({ value, children }: PromptQueueProviderProps): React.JSX.Element => (
  <PromptQueueContext.Provider value={value}>{children}</PromptQueueContext.Provider>
);

export const usePromptQueue = (): PromptQueue => {
  const ctx = useContext(PromptQueueContext);
  if (!ctx) throw new Error('usePromptQueue: must be used inside <PromptQueueProvider>');
  return ctx;
};
