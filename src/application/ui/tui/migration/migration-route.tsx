/**
 * Pre-app route wrapper that gates the main {@link App} behind the {@link MigrationGate}. Mounted by `launch.ts` ONLY
 * when `needsMigration(dataRoot)` is true.
 */

import React, { useState } from 'react';
import { useApp } from 'ink';
import { App, type AppProps } from '@src/application/ui/tui/App.tsx';
import { MigrationGate, type MigrationGateProps } from '@src/application/ui/tui/migration/migration-gate.tsx';

export interface MigrationRouteProps {
  /** Everything the gate needs except the resolve/quit callbacks (those are owned here). */
  readonly gate: Omit<MigrationGateProps, 'onResolve' | 'onQuit'>;
  /** Props for the main app, mounted once the gate resolves. */
  readonly app: AppProps;
  /**
   * Notify the launcher that the gate resolved, so a later pause/resume remount renders the App directly rather than
   * re-showing the gate (the render thunk reads this flag).
   */
  readonly onResolved?: () => void;
}

export const MigrationRoute = ({ gate, app, onResolved }: MigrationRouteProps): React.JSX.Element => {
  const [resolved, setResolved] = useState(false);
  const { exit } = useApp();

  if (resolved) return <App {...app} />;
  return (
    <MigrationGate
      {...gate}
      onResolve={(): void => {
        // Every non-quit outcome (migrated / skipped / failed-continue) proceeds into the app — the tolerant readers
        // serve any tree the migration left behind.
        onResolved?.();
        setResolved(true);
      }}
      onQuit={(): void => {
        exit();
      }}
    />
  );
};
