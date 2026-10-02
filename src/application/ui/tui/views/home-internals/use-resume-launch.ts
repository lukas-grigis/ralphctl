/** Resuming Implement from Home: stale run records are superseded only once the resume actually started. */

import { useCallback } from 'react';
import { useFlowLauncher } from '@src/application/ui/tui/runtime/use-flow-launcher.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';

/** A cancelled or refused launch keeps the records, so the operator can try again. */
export const useResumeLaunch = (
  snapshot: AppStateSnapshot | undefined,
  reload: () => void,
  dismissStale: () => Promise<void>
): { readonly resume: () => void; readonly launchError: string | undefined } => {
  const { launch, launchError } = useFlowLauncher({ snapshot, reload });
  const resume = useCallback((): void => {
    void (async (): Promise<void> => {
      if (await launch('implement')) await dismissStale();
    })();
  }, [launch, dismissStale]);
  return { resume, launchError };
};
