/**
 * Provides resolved {@link StoragePaths} via context so views and the flow launcher don't need
 * to thread paths through props. The bootstrap layer assembles paths once and supplies them
 * here.
 */

import React, { createContext, useContext } from 'react';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';

const StorageContext = createContext<StoragePaths | undefined>(undefined);

export interface StorageProviderProps {
  readonly value: StoragePaths;
  readonly children: React.ReactNode;
}

export const StorageProvider = ({ value, children }: StorageProviderProps): React.JSX.Element => (
  <StorageContext.Provider value={value}>{children}</StorageContext.Provider>
);

export const useStorage = (): StoragePaths => {
  const ctx = useContext(StorageContext);
  if (!ctx) throw new Error('useStorage: must be used inside <StorageProvider>');
  return ctx;
};
