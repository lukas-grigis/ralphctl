/**
 * Pre-app route wrapper that gates the main {@link App} behind the {@link MigrationGate}.
 *
 * Mounted by `launch.ts` ONLY when `needsMigration(dataRoot)` is true. It renders the consent gate
 * first; once the gate resolves (migrated / skipped / failed-continue) it swaps to the real App with
 * the same props. A `quit` from the failure screen exits the Ink host instead of mounting the app.
 *
 * Keeping the gate INSIDE the Ink host (an initial route, not a separate process) means one
 * alternate-screen session, one clean teardown, and no second mount flash between the gate and the
 * app. The App's own provider stack mounts only after the gate is gone, so the gate never competes
 * with it for input or context.
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
   * Notify the launcher that the gate resolved, so a later pause/resume remount renders the App
   * directly rather than re-showing the gate (the render thunk reads this flag). Within a single
   * mount the local state already swaps to the App; this is purely for the remount case.
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
        // Every non-quit outcome (migrated / skipped / failed-continue) proceeds into the app — the
        // tolerant readers serve any tree the migration left behind. The specific outcome only
        // affects whether the data is v2 yet; the app boots the same way either way.
        onResolved?.();
        setResolved(true);
      }}
      onQuit={(): void => {
        exit();
      }}
    />
  );
};
